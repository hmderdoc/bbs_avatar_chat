import { buildNoticeMessage, normalizeChannelName, trimChannelMessages } from "../domain/chat-model";
import { ACTION_BAR_ACTIONS, AppModalState, ChannelListEntry, RosterEntry } from "../domain/ui";
import { InputBuffer } from "../input/input-buffer";
import { AvatarChatConfig } from "../io/config";
import { AvatarCache } from "../render/avatar";
import { renderActionBar, renderModal } from "../render/modal-renderer";
import { renderTranscript, TranscriptRenderState } from "../render/transcript-renderer";
import { clamp, clipText, padRight, trimText } from "../util/text";

interface FrameState {
  root: Frame | null;
  header: Frame | null;
  actions: Frame | null;
  transcript: Frame | null;
  status: Frame | null;
  input: Frame | null;
  overlay: Frame | null;
  modal: Frame | null;
  width: number;
  height: number;
}

interface ModalGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

const INPUT_ESCAPE_SEQUENCE_MAP: { [sequence: string]: string } = {
  "\x1b[A": KEY_UP,
  "\x1b[B": KEY_DOWN,
  "\x1b[C": KEY_RIGHT,
  "\x1b[D": KEY_LEFT,
  "\x1bOA": KEY_UP,
  "\x1bOB": KEY_DOWN,
  "\x1bOC": KEY_RIGHT,
  "\x1bOD": KEY_LEFT,
  "\x1b[H": KEY_HOME,
  "\x1b[F": KEY_END,
  "\x1bOH": KEY_HOME,
  "\x1bOF": KEY_END,
  "\x1b[1~": KEY_HOME,
  "\x1b[4~": KEY_END,
  "\x1b[7~": KEY_HOME,
  "\x1b[8~": KEY_END,
  "\x1b[5~": KEY_PAGEUP,
  "\x1b[6~": KEY_PAGEDN
};

const INPUT_ESCAPE_SEQUENCE_PREFIXES: { [prefix: string]: boolean } = {
  "\x1b": true
};

(function seedInputEscapePrefixes(): void {
  let sequence = "";
  let prefixLength = 0;

  for (sequence in INPUT_ESCAPE_SEQUENCE_MAP) {
    if (!Object.prototype.hasOwnProperty.call(INPUT_ESCAPE_SEQUENCE_MAP, sequence)) {
      continue;
    }

    for (prefixLength = 1; prefixLength < sequence.length; prefixLength += 1) {
      INPUT_ESCAPE_SEQUENCE_PREFIXES[sequence.substr(0, prefixLength)] = true;
    }
  }
})();

export class AvatarChatApp {
  private readonly config: AvatarChatConfig;
  private readonly inputBuffer: InputBuffer;
  private readonly avatarCache: AvatarCache;
  private avatarLib: AvatarLibrary | null;
  private chat: JSONChat | null;
  private frames: FrameState;
  private channelOrder: string[];
  private currentChannel: string;
  private reconnectAt: number;
  private lastError: string;
  private shouldExit: boolean;
  private modalState: AppModalState | null;
  private transcriptSignature: string;
  private headerSignature: string;
  private actionSignature: string;
  private statusSignature: string;
  private inputSignature: string;
  private modalSignature: string;
  private transcriptScrollOffsetBlocks: number;
  private transcriptVisibleBlockCount: number;
  private transcriptMaxScrollOffsetBlocks: number;
  private pendingEscapeSequence: string;
  private pendingEscapeAt: number;
  private lastWasCarriageReturn: boolean;

  public constructor(config: AvatarChatConfig) {
    this.config = config;
    this.inputBuffer = new InputBuffer(config.inputMaxLength);
    this.avatarCache = {};
    this.avatarLib = null;
    this.chat = null;
    this.frames = {
      root: null,
      header: null,
      actions: null,
      transcript: null,
      status: null,
      input: null,
      overlay: null,
      modal: null,
      width: 0,
      height: 0
    };
    this.channelOrder = [normalizeChannelName(config.defaultChannel)];
    this.currentChannel = normalizeChannelName(config.defaultChannel);
    this.reconnectAt = 0;
    this.lastError = "";
    this.shouldExit = false;
    this.modalState = null;
    this.transcriptSignature = "";
    this.headerSignature = "";
    this.actionSignature = "";
    this.statusSignature = "";
    this.inputSignature = "";
    this.modalSignature = "";
    this.transcriptScrollOffsetBlocks = 0;
    this.transcriptVisibleBlockCount = 0;
    this.transcriptMaxScrollOffsetBlocks = 0;
    this.pendingEscapeSequence = "";
    this.pendingEscapeAt = 0;
    this.lastWasCarriageReturn = false;

    try {
      this.avatarLib = load({}, "avatar_lib.js") as AvatarLibrary;
    } catch (error) {
      this.avatarLib = null;
      log("Avatar Chat: avatar_lib.js unavailable: " + String(error));
    }
  }

  public run(): void {
    try {
      console.clear(BG_BLACK | LIGHTGRAY);
      bbs.command_str = "";
      this.connect();

      while (bbs.online && !js.terminated && !this.shouldExit) {
        this.cycleChat();
        this.reconnectIfDue();
        this.handlePendingInput();
        this.render();
      }
    } finally {
      this.destroyFrames();
      console.clear(BG_BLACK | LIGHTGRAY);
      console.home();
    }
  }

  private connect(): void {
    const desiredChannels = this.channelOrder.length ? this.channelOrder.slice(0) : [this.config.defaultChannel];
    const desiredCurrent = this.currentChannel;
    let client;
    let index = 0;

    try {
      client = new JSONClient(this.config.host, this.config.port);
      this.chat = new JSONChat(user.number, client);
      this.chat.settings.MAX_HISTORY = this.config.maxHistory;

      for (index = 0; index < desiredChannels.length; index += 1) {
        const desiredChannel = desiredChannels[index];
        const channelName = normalizeChannelName(desiredChannel || this.config.defaultChannel, this.config.defaultChannel);

        if (!this.getChannelByName(channelName)) {
          this.chat.join(channelName);
        }
      }

      this.syncChannelOrder();

      if (desiredCurrent && this.getChannelByName(desiredCurrent)) {
        this.currentChannel = desiredCurrent;
      } else if (this.channelOrder.length > 0) {
        this.currentChannel = this.channelOrder[0] || this.config.defaultChannel;
      }

      this.transcriptScrollOffsetBlocks = 0;
      this.transcriptVisibleBlockCount = 0;
      this.transcriptMaxScrollOffsetBlocks = 0;
      this.reconnectAt = 0;
      this.lastError = "";
      this.resetRenderSignatures();
    } catch (error) {
      this.chat = null;
      this.scheduleReconnect("Connection failed: " + String(error));
    }
  }

  private cycleChat(): void {
    if (!this.chat) {
      return;
    }

    try {
      this.chat.cycle();
      this.syncChannelOrder();
      this.trimHistories();
    } catch (error) {
      try {
        this.chat.disconnect();
      } catch (_disconnectError) {
      }
      this.chat = null;
      this.scheduleReconnect("Connection lost: " + String(error));
    }
  }

  private reconnectIfDue(): void {
    if (this.chat || !this.reconnectAt) {
      return;
    }

    if (new Date().getTime() >= this.reconnectAt) {
      this.connect();
    }
  }

  private scheduleReconnect(errorText: string): void {
    this.lastError = errorText;
    this.reconnectAt = new Date().getTime() + this.config.reconnectDelayMs;
    this.resetRenderSignatures();
  }

  private handlePendingInput(): void {
    const key = this.readInputKey();

    if (!key) {
      return;
    }

    if (this.modalState && this.handleModalInput(key)) {
      return;
    }

    switch (key) {
      case KEY_ESC:
      case "\x1b":
      case "\x11":
        this.performAction("exit");
        return;
      case KEY_UP:
        this.scrollTranscriptOlder(1);
        return;
      case KEY_DOWN:
        this.scrollTranscriptNewer(1);
        return;
      case KEY_PAGEUP:
        this.pageTranscriptOlder();
        return;
      case KEY_PAGEDN:
        this.pageTranscriptNewer();
        return;
      case "\r":
        this.submitInput();
        return;
      case "\t":
        this.performAction("next");
        return;
      case KEY_LEFT:
        this.inputBuffer.moveLeft();
        return;
      case KEY_RIGHT:
        this.inputBuffer.moveRight();
        return;
      case KEY_HOME:
        if (this.inputBuffer.isEmpty()) {
          this.scrollTranscriptToOldest();
          return;
        }
        this.inputBuffer.moveHome();
        return;
      case KEY_END:
        if (this.inputBuffer.isEmpty()) {
          this.scrollTranscriptToLatest();
          return;
        }
        this.inputBuffer.moveEnd();
        return;
      case "\b":
      case "\x7f":
        this.inputBuffer.backspace();
        return;
      case "\x0c":
        this.resetRenderSignatures();
        return;
      default:
        if (this.isPrintable(key)) {
          this.inputBuffer.insert(key);
        }
        return;
    }
  }

  private readInputKey(): string {
    const mode = K_NOCRLF | K_NOECHO | K_NOSPIN | K_EXTKEYS;
    const key = console.inkey(mode, this.pendingEscapeSequence.length ? 0 : this.config.pollDelayMs);

    if (!key) {
      if (this.pendingEscapeSequence.length && new Date().getTime() - this.pendingEscapeAt >= 75) {
        this.pendingEscapeSequence = "";
        this.pendingEscapeAt = 0;
        return KEY_ESC;
      }
      return "";
    }

    return this.normalizeInputKey(key, mode);
  }

  private normalizeInputKey(key: string, mode: number): string {
    let next = "";
    let mapped = "";

    if (this.pendingEscapeSequence.length) {
      this.pendingEscapeSequence += key;
      return this.resolveEscapeSequence(mode);
    }

    if (key === KEY_ESC || key === "\x1b") {
      this.pendingEscapeSequence = KEY_ESC;
      this.pendingEscapeAt = new Date().getTime();
      return this.resolveEscapeSequence(mode);
    }

    if (key === "\r") {
      this.lastWasCarriageReturn = true;
      return key;
    }

    if (key === "\n") {
      if (this.lastWasCarriageReturn) {
        this.lastWasCarriageReturn = false;
        return "";
      }
      return KEY_DOWN;
    }

    this.lastWasCarriageReturn = false;
    mapped = this.normalizeImmediateKey(key);
    if (mapped.length) {
      return mapped;
    }

    next = INPUT_ESCAPE_SEQUENCE_MAP[key] || "";
    return next.length ? next : key;
  }

  private normalizeImmediateKey(key: string): string {
    switch (key) {
      case "KEY_UP":
      case KEY_UP:
        return KEY_UP;
      case "KEY_DOWN":
      case KEY_DOWN:
        return KEY_DOWN;
      case "KEY_LEFT":
      case KEY_LEFT:
        return KEY_LEFT;
      case "KEY_RIGHT":
      case KEY_RIGHT:
        return KEY_RIGHT;
      case "KEY_HOME":
      case KEY_HOME:
        return KEY_HOME;
      case "KEY_END":
      case KEY_END:
        return KEY_END;
      case "KEY_PAGEUP":
      case KEY_PAGEUP:
        return KEY_PAGEUP;
      case "KEY_PAGEDN":
      case KEY_PAGEDN:
        return KEY_PAGEDN;
      default:
        return "";
    }
  }

  private resolveEscapeSequence(mode: number): string {
    let next = "";
    let mapped = "";

    while (this.pendingEscapeSequence.length) {
      mapped = INPUT_ESCAPE_SEQUENCE_MAP[this.pendingEscapeSequence] || "";
      if (mapped.length) {
        this.pendingEscapeSequence = "";
        this.pendingEscapeAt = 0;
        this.lastWasCarriageReturn = false;
        return mapped;
      }

      if (!INPUT_ESCAPE_SEQUENCE_PREFIXES[this.pendingEscapeSequence]) {
        this.pendingEscapeSequence = "";
        this.pendingEscapeAt = 0;
        return KEY_ESC;
      }

      next = console.inkey(mode, 0);
      if (!next) {
        return "";
      }

      this.pendingEscapeSequence += next;
    }

    return "";
  }

  private handleModalInput(key: string): boolean {
    if (!this.modalState) {
      return false;
    }

    switch (key) {
      case KEY_UP:
        this.moveModalSelection(-1);
        return true;
      case KEY_DOWN:
        this.moveModalSelection(1);
        return true;
      case KEY_HOME:
        this.jumpModalSelection(0);
        return true;
      case KEY_END:
        this.jumpModalSelection(this.getModalItemCount() - 1);
        return true;
      case KEY_PAGEUP:
        this.moveModalSelection(-5);
        return true;
      case KEY_PAGEDN:
        this.moveModalSelection(5);
        return true;
      case KEY_ESC:
      case "\x1b":
      case "\r":
        if (this.modalState.kind === "channels" && this.modalState.entries.length) {
          const selected = this.modalState.entries[this.modalState.selectedIndex];
          if (selected) {
            this.currentChannel = selected.name;
            this.scrollTranscriptToLatest();
          }
        }
        this.closeModal();
        return true;
      case "\x0c":
        this.resetRenderSignatures();
        return true;
      default:
        return true;
    }
  }

  private submitInput(): void {
    const text = this.inputBuffer.getValue();
    const trimmed = trimText(text);

    if (!trimmed.length) {
      this.inputBuffer.clear();
      return;
    }

    if (trimmed.charAt(0) === "/") {
      this.handleSlashCommand(trimmed);
      this.inputBuffer.clear();
      return;
    }

    if (!this.chat || !this.currentChannel.length) {
      this.lastError = "Not connected to chat";
      this.inputBuffer.clear();
      return;
    }

    this.scrollTranscriptToLatest();

    if (!this.sendMessage(this.currentChannel, trimmed)) {
      this.appendNotice(this.currentChannel, "Unable to send message.");
    }

    this.inputBuffer.clear();
  }

  private sendMessage(channelName: string, text: string): boolean {
    const channel = this.getChannelByName(channelName);
    const timestamp = new Date().getTime();
    const message = {
      nick: {
        name: user.alias,
        host: system.name,
        ip: user.ip_address,
        qwkid: system.qwk_id
      },
      str: text,
      time: timestamp
    };

    if (!this.chat || !channel) {
      return false;
    }

    try {
      this.chat.client.write("chat", "channels." + channel.name + ".messages", message, 2);
      this.chat.client.push("chat", "channels." + channel.name + ".history", message, 2);
      channel.messages.push(message);
      trimChannelMessages(channel, this.config.maxHistory);
      this.transcriptSignature = "";
      this.statusSignature = "";
      return true;
    } catch (_error) {
      return false;
    }
  }

  private handleSlashCommand(commandText: string): void {
    const trimmedCommand = trimText(commandText.substr(1));
    const parts = trimmedCommand.split(/\s+/);
    const firstPart = parts.length ? (parts[0] || "") : "";
    const verb = firstPart.length ? firstPart.toUpperCase() : "";
    const args = trimmedCommand.length > verb.length ? trimText(trimmedCommand.substr(verb.length)) : "";
    let targetChannel = "";

    if (!verb.length) {
      return;
    }

    switch (verb) {
      case "HELP":
        this.performAction("help");
        return;
      case "WHO":
        this.performAction("who");
        return;
      case "CHANNELS":
        this.performAction("channels");
        return;
      case "EXIT":
      case "QUIT":
        this.performAction("exit");
        return;
      case "OPEN":
      case "CONNECT":
        if (!this.chat) {
          this.connect();
        }
        return;
      case "CLOSE":
      case "DISCONNECT":
        if (this.chat) {
          try {
            this.chat.disconnect();
          } catch (_disconnectError) {
          }
          this.chat = null;
          this.scheduleReconnect("Disconnected.");
        }
        return;
      default:
        break;
    }

    if (!this.chat || !this.currentChannel.length) {
      this.lastError = "Not connected to chat";
      return;
    }

    if (verb === "JOIN" && !args.length) {
      this.appendNotice(this.currentChannel, "Usage: /join <channel>");
      return;
    }

    if (verb === "ME" && !args.length) {
      this.appendNotice(this.currentChannel, "Usage: /me <action>");
      return;
    }

    if (!this.chat.getcmd(this.currentChannel, commandText)) {
      this.appendNotice(this.currentChannel, "Unknown command: " + commandText);
      return;
    }

    if (verb === "JOIN") {
      targetChannel = normalizeChannelName(args, this.config.defaultChannel);
      this.syncChannelOrder();
      if (this.getChannelByName(targetChannel)) {
        this.currentChannel = targetChannel;
        this.scrollTranscriptToLatest();
      }
      return;
    }

    if (verb === "PART") {
      this.syncChannelOrder();
      if (!this.getChannelByName(this.currentChannel)) {
        this.currentChannel = this.channelOrder.length ? (this.channelOrder[0] || "") : "";
        this.scrollTranscriptToLatest();
      }
      this.resetRenderSignatures();
      return;
    }

    this.resetRenderSignatures();
  }

  private performAction(actionId: string): void {
    switch (actionId) {
      case "who":
        this.openRosterModal();
        return;
      case "channels":
        this.openChannelsModal();
        return;
      case "help":
        this.openHelpModal();
        return;
      case "next":
        this.cycleChannel();
        return;
      case "exit":
        this.shouldExit = true;
        return;
      default:
        return;
    }
  }

  private openRosterModal(): void {
    const entries = this.buildRosterEntries();
    let selectedIndex = 0;
    let index = 0;

    for (index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry && entry.isSelf) {
        selectedIndex = index;
        break;
      }
    }

    this.modalState = {
      kind: "roster",
      title: "Who's Here",
      selectedIndex: selectedIndex,
      entries: entries
    };
    this.resetRenderSignatures();
  }

  private openChannelsModal(): void {
    const entries = this.buildChannelEntries();
    let selectedIndex = 0;
    let index = 0;

    for (index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry && entry.isCurrent) {
        selectedIndex = index;
        break;
      }
    }

    this.modalState = {
      kind: "channels",
      title: "Channels",
      selectedIndex: selectedIndex,
      entries: entries
    };
    this.resetRenderSignatures();
  }

  private openHelpModal(): void {
    this.modalState = {
      kind: "help",
      title: "Help",
      selectedIndex: 0,
      lines: [
        "Slash commands:",
        "/who, /channels, /help, /join <channel>, /part [channel], /me <action>, /clear",
        "",
        "Keys:",
        "Tab cycles joined channels.",
        "Esc exits the chat or closes a modal.",
        "Arrow keys, Home/End, and Backspace edit the input line.",
        "",
        "The top action bar is keyboard-first today and can grow mouse support later."
      ]
    };
    this.resetRenderSignatures();
  }

  private closeModal(): void {
    this.modalState = null;
    this.destroyModalFrames();
    this.resetRenderSignatures();
  }

  private getModalItemCount(): number {
    if (!this.modalState) {
      return 0;
    }

    if (this.modalState.kind === "help") {
      return 0;
    }

    return this.modalState.entries.length;
  }

  private moveModalSelection(delta: number): void {
    const itemCount = this.getModalItemCount();

    if (!this.modalState || this.modalState.kind === "help" || itemCount < 1) {
      return;
    }

    this.modalState.selectedIndex = clamp(this.modalState.selectedIndex + delta, 0, itemCount - 1);
  }

  private jumpModalSelection(index: number): void {
    const itemCount = this.getModalItemCount();

    if (!this.modalState || this.modalState.kind === "help" || itemCount < 1) {
      return;
    }

    this.modalState.selectedIndex = clamp(index, 0, itemCount - 1);
  }

  private buildRosterEntries(): RosterEntry[] {
    const entries: RosterEntry[] = [];
    const seen: { [key: string]: boolean } = {};
    const channel = this.currentChannel.length ? this.getChannelByName(this.currentChannel) : null;
    let index = 0;

    this.addRosterEntry(
      entries,
      seen,
      user.alias,
      system.name,
      { name: user.alias, host: system.name, ip: user.ip_address, qwkid: system.qwk_id },
      true
    );

    if (channel && channel.users) {
      for (index = 0; index < channel.users.length; index += 1) {
        const rawEntry = channel.users[index] as any;
        const rosterEntry = this.extractRosterEntry(rawEntry);

        if (rosterEntry) {
          this.addRosterEntry(
            entries,
            seen,
            rosterEntry.name,
            rosterEntry.bbs,
            rosterEntry.nick,
            rosterEntry.isSelf
          );
        }
      }
    }

    entries.sort(function (left, right) {
      if (left.isSelf !== right.isSelf) {
        return left.isSelf ? -1 : 1;
      }
      if (left.name.toUpperCase() < right.name.toUpperCase()) {
        return -1;
      }
      if (left.name.toUpperCase() > right.name.toUpperCase()) {
        return 1;
      }
      if (left.bbs.toUpperCase() < right.bbs.toUpperCase()) {
        return -1;
      }
      if (left.bbs.toUpperCase() > right.bbs.toUpperCase()) {
        return 1;
      }
      return 0;
    });

    return entries;
  }

  private addRosterEntry(
    entries: RosterEntry[],
    seen: { [key: string]: boolean },
    name: string,
    bbs: string,
    nick: ChatNick | null,
    isSelf: boolean
  ): void {
    const trimmedName = trimText(name);
    const trimmedBbs = trimText(bbs || system.name);
    const key = trimmedName.toUpperCase() + "|" + trimmedBbs.toUpperCase();

    if (!trimmedName.length || seen[key]) {
      return;
    }

    seen[key] = true;
    entries.push({
      name: trimmedName,
      bbs: trimmedBbs || "Unknown BBS",
      nick: nick,
      isSelf: isSelf
    });
  }

  private extractRosterEntry(rawEntry: any): RosterEntry | null {
    let name = "";
    let bbs = "";
    let nick: ChatNick | null = null;
    let nickValue = null;

    if (!rawEntry) {
      return null;
    }

    nickValue = rawEntry.nick;

    if (nickValue && typeof nickValue === "object") {
      name = trimText(String(nickValue.name || nickValue.alias || nickValue.user || ""));
      bbs = trimText(String(nickValue.host || rawEntry.system || rawEntry.host || rawEntry.bbs || system.name));
      nick = {
        name: name,
        host: bbs,
        ip: nickValue.ip || rawEntry.ip || undefined,
        qwkid: nickValue.qwkid || rawEntry.qwkid || undefined
      };
    } else {
      name = trimText(String(nickValue || rawEntry.name || rawEntry.alias || rawEntry.user || ""));
      bbs = trimText(String(rawEntry.system || rawEntry.host || rawEntry.bbs || system.name));
      if (name.length) {
        nick = {
          name: name,
          host: bbs,
          qwkid: rawEntry.qwkid || undefined
        };
      }
    }

    if (!name.length) {
      return null;
    }

    return {
      name: name,
      bbs: bbs || "Unknown BBS",
      nick: nick,
      isSelf: name.toUpperCase() === user.alias.toUpperCase()
    };
  }

  private buildChannelEntries(): ChannelListEntry[] {
    const entries: ChannelListEntry[] = [];
    let index = 0;

    for (index = 0; index < this.channelOrder.length; index += 1) {
      const channelName = this.channelOrder[index];
      const channel = channelName ? this.getChannelByName(channelName) : null;

      if (!channelName) {
        continue;
      }

      entries.push({
        name: channelName,
        userCount: channel && channel.users ? channel.users.length : 0,
        isCurrent: channelName.toUpperCase() === this.currentChannel.toUpperCase()
      });
    }

    return entries;
  }

  private appendNotice(channelName: string, text: string): void {
    const channel = this.getChannelByName(channelName);

    if (!channel) {
      this.lastError = text;
      return;
    }

    channel.messages.push(buildNoticeMessage(text));
    trimChannelMessages(channel, this.config.maxHistory);
    this.transcriptSignature = "";
  }

  private scrollTranscriptOlder(step: number): void {
    this.setTranscriptScrollOffset(this.transcriptScrollOffsetBlocks + Math.max(1, step));
  }

  private scrollTranscriptNewer(step: number): void {
    this.setTranscriptScrollOffset(this.transcriptScrollOffsetBlocks - Math.max(1, step));
  }

  private pageTranscriptOlder(): void {
    this.scrollTranscriptOlder(Math.max(1, this.transcriptVisibleBlockCount - 1));
  }

  private pageTranscriptNewer(): void {
    this.scrollTranscriptNewer(Math.max(1, this.transcriptVisibleBlockCount - 1));
  }

  private scrollTranscriptToLatest(): void {
    this.setTranscriptScrollOffset(0);
  }

  private scrollTranscriptToOldest(): void {
    this.setTranscriptScrollOffset(this.transcriptMaxScrollOffsetBlocks);
  }

  private setTranscriptScrollOffset(nextOffset: number): void {
    const clampedOffset = clamp(nextOffset, 0, this.transcriptMaxScrollOffsetBlocks);

    if (clampedOffset === this.transcriptScrollOffsetBlocks) {
      return;
    }

    this.transcriptScrollOffsetBlocks = clampedOffset;
    this.transcriptSignature = "";
    this.statusSignature = "";
  }

  private isPrintable(key: string): boolean {
    const code = key.charCodeAt(0);
    return key.length === 1 && code >= 32 && code !== 127;
  }

  private cycleChannel(): void {
    let index = 0;

    if (this.channelOrder.length < 2) {
      return;
    }

    for (index = 0; index < this.channelOrder.length; index += 1) {
      const channelName = this.channelOrder[index];

      if (!channelName) {
        continue;
      }

      if (channelName.toUpperCase() === this.currentChannel.toUpperCase()) {
        this.currentChannel = this.channelOrder[(index + 1) % this.channelOrder.length] || this.config.defaultChannel;
        this.scrollTranscriptToLatest();
        this.transcriptSignature = "";
        this.headerSignature = "";
        return;
      }
    }

    this.currentChannel = this.channelOrder[0] || this.config.defaultChannel;
    this.scrollTranscriptToLatest();
  }

  private syncChannelOrder(): void {
    const nextOrder: string[] = [];
    let key = "";
    let index = 0;

    if (!this.chat) {
      return;
    }

    for (index = 0; index < this.channelOrder.length; index += 1) {
      const channelName = this.channelOrder[index];
      const existing = channelName ? this.getChannelByName(channelName) : null;
      if (existing) {
        nextOrder.push(existing.name);
      }
    }

    for (key in this.chat.channels) {
      if (Object.prototype.hasOwnProperty.call(this.chat.channels, key)) {
        const channel = this.chat.channels[key];
        if (channel && !this.channelExists(nextOrder, channel.name)) {
          nextOrder.push(channel.name);
        }
      }
    }

    this.channelOrder = nextOrder;

    if (!this.channelOrder.length) {
      this.currentChannel = "";
      this.transcriptScrollOffsetBlocks = 0;
      return;
    }

    if (!this.currentChannel.length || !this.getChannelByName(this.currentChannel)) {
      this.currentChannel = this.channelOrder[0] || "";
      this.scrollTranscriptToLatest();
    }
  }

  private channelExists(channels: string[], target: string): boolean {
    let index = 0;

    for (index = 0; index < channels.length; index += 1) {
      const channelName = channels[index];
      if (channelName && channelName.toUpperCase() === target.toUpperCase()) {
        return true;
      }
    }

    return false;
  }

  private trimHistories(): void {
    let key = "";

    if (!this.chat) {
      return;
    }

    for (key in this.chat.channels) {
      if (Object.prototype.hasOwnProperty.call(this.chat.channels, key)) {
        const channel = this.chat.channels[key];
        if (channel) {
          trimChannelMessages(channel, this.config.maxHistory);
        }
      }
    }
  }

  private getChannelByName(name: string): ChatChannel | null {
    let key = "";
    const upper = name.toUpperCase();

    if (!this.chat) {
      return null;
    }

    for (key in this.chat.channels) {
      if (Object.prototype.hasOwnProperty.call(this.chat.channels, key)) {
        const channel = this.chat.channels[key];
        if (channel && channel.name.toUpperCase() === upper) {
          return channel;
        }
      }
    }

    return null;
  }

  private ensureFrames(): void {
    const width = console.screen_columns;
    const height = console.screen_rows;
    const transcriptHeight = Math.max(1, height - 4);

    if (
      this.frames.root &&
      this.frames.width === width &&
      this.frames.height === height
    ) {
      return;
    }

    this.destroyFrames();

    this.frames.root = new Frame(1, 1, width, height, BG_BLACK | LIGHTGRAY);
    this.frames.root.open();

    this.frames.header = new Frame(1, 1, width, 1, BG_GREEN | BLACK, this.frames.root);
    this.frames.header.open();

    this.frames.actions = new Frame(1, 2, width, 1, BG_BLUE | WHITE, this.frames.root);
    this.frames.actions.open();

    this.frames.transcript = new Frame(1, 3, width, transcriptHeight, BG_BLACK | LIGHTGRAY, this.frames.root);
    this.frames.transcript.open();

    this.frames.status = new Frame(1, transcriptHeight + 3, width, 1, BG_MAGENTA | WHITE, this.frames.root);
    this.frames.status.open();

    this.frames.input = new Frame(1, transcriptHeight + 4, width, 1, BG_BLACK | WHITE, this.frames.root);
    this.frames.input.open();

    this.frames.width = width;
    this.frames.height = height;
    this.resetRenderSignatures();
  }

  private ensureModalFrames(): void {
    const geometry = this.getModalGeometry();

    if (!this.modalState || !this.frames.root || !geometry) {
      this.destroyModalFrames();
      return;
    }

    if (
      this.frames.overlay &&
      this.frames.modal &&
      this.frames.overlay.width === this.frames.width &&
      this.frames.overlay.height === this.frames.height &&
      this.frames.modal.width === geometry.width &&
      this.frames.modal.height === geometry.height
    ) {
      return;
    }

    this.destroyModalFrames();

    this.frames.overlay = new Frame(1, 1, this.frames.width, this.frames.height, BG_BLACK | DARKGRAY, this.frames.root);
    this.frames.overlay.open();

    this.frames.modal = new Frame(
      geometry.x,
      geometry.y,
      geometry.width,
      geometry.height,
      BG_BLACK | LIGHTGRAY,
      this.frames.overlay
    );
    this.frames.modal.open();
  }

  private getModalGeometry(): ModalGeometry | null {
    let width = 0;
    let height = 0;
    let x = 0;
    let y = 0;

    if (!this.modalState || !this.frames.width || !this.frames.height) {
      return null;
    }

    switch (this.modalState.kind) {
      case "roster":
        width = clamp(this.frames.width - 6, 36, 74);
        height = clamp(this.frames.height - 6, 12, 18);
        break;
      case "channels":
        width = clamp(this.frames.width - 10, 30, 56);
        height = clamp(this.frames.height - 8, 10, 16);
        break;
      case "help":
        width = clamp(this.frames.width - 8, 34, 64);
        height = clamp(this.frames.height - 8, 12, 18);
        break;
      default:
        return null;
    }

    x = Math.max(1, Math.floor((this.frames.width - width) / 2) + 1);
    y = Math.max(1, Math.floor((this.frames.height - height) / 2) + 1);

    return {
      x: x,
      y: y,
      width: width,
      height: height
    };
  }

  private destroyModalFrames(): void {
    if (this.frames.modal) {
      this.frames.modal.close();
    }
    if (this.frames.overlay) {
      this.frames.overlay.close();
    }

    this.frames.modal = null;
    this.frames.overlay = null;
  }

  private destroyFrames(): void {
    this.destroyModalFrames();

    if (this.frames.input) {
      this.frames.input.close();
    }
    if (this.frames.status) {
      this.frames.status.close();
    }
    if (this.frames.transcript) {
      this.frames.transcript.close();
    }
    if (this.frames.actions) {
      this.frames.actions.close();
    }
    if (this.frames.header) {
      this.frames.header.close();
    }
    if (this.frames.root) {
      this.frames.root.close();
    }

    this.frames.root = null;
    this.frames.header = null;
    this.frames.actions = null;
    this.frames.transcript = null;
    this.frames.status = null;
    this.frames.input = null;
    this.frames.width = 0;
    this.frames.height = 0;
  }

  private render(): void {
    this.ensureFrames();
    this.renderHeader();
    this.renderActions();
    this.renderTranscript();
    this.renderStatus();
    this.renderInput();
    this.renderActiveModal();

    if (this.frames.root) {
      this.frames.root.cycle();
    }
  }

  private renderHeader(): void {
    const headerFrame = this.frames.header;
    const channel = this.currentChannel.length ? this.getChannelByName(this.currentChannel) : null;
    const users = channel && channel.users ? channel.users.length : 0;
    const text = clipText(
      " Avatar Chat | " +
      (this.currentChannel || "offline") +
      " | users " +
      String(users) +
      " | joined " +
      String(this.channelOrder.length) +
      " | " +
      this.config.host +
      ":" +
      String(this.config.port),
      this.frames.width
    );

    if (!headerFrame) {
      return;
    }

    if (text === this.headerSignature) {
      return;
    }

    headerFrame.clear(BG_GREEN | BLACK);
    headerFrame.gotoxy(1, 1);
    headerFrame.putmsg(padRight(text, headerFrame.width), BG_GREEN | BLACK);
    this.headerSignature = text;
  }

  private renderActions(): void {
    const actionsFrame = this.frames.actions;
    const signature = String(this.frames.width) + "|" + ACTION_BAR_ACTIONS.length;

    if (!actionsFrame) {
      return;
    }

    if (signature === this.actionSignature) {
      return;
    }

    renderActionBar(actionsFrame, ACTION_BAR_ACTIONS);
    this.actionSignature = signature;
  }

  private renderTranscript(): void {
    const transcriptFrame = this.frames.transcript;
    const channel = this.currentChannel.length ? this.getChannelByName(this.currentChannel) : null;
    const signature = this.buildTranscriptSignature(channel);
    let renderState: TranscriptRenderState;
    let emptyText = "";

    if (!transcriptFrame) {
      return;
    }

    if (signature === this.transcriptSignature) {
      return;
    }

    if (!this.chat) {
      emptyText = this.buildDisconnectedText();
    } else if (!channel) {
      emptyText = "No joined channels. Use /join <channel>.";
    } else {
      emptyText = "No messages yet.";
    }

    renderState = renderTranscript(
      transcriptFrame,
      channel ? channel.messages : [],
      {
        ownAlias: user.alias,
        ownUserNumber: user.number,
        avatarLib: this.avatarLib,
        avatarCache: this.avatarCache,
        emptyText: emptyText,
        scrollOffsetBlocks: this.transcriptScrollOffsetBlocks
      }
    );

    this.transcriptVisibleBlockCount = renderState.visibleBlockCount;
    this.transcriptMaxScrollOffsetBlocks = renderState.maxScrollOffsetBlocks;
    this.transcriptScrollOffsetBlocks = renderState.actualScrollOffsetBlocks;

    this.transcriptSignature = signature;
  }

  private renderStatus(): void {
    const statusFrame = this.frames.status;
    const text = clipText(this.buildStatusText(), this.frames.width);

    if (!statusFrame) {
      return;
    }

    if (text === this.statusSignature) {
      return;
    }

    statusFrame.clear(BG_MAGENTA | WHITE);
    statusFrame.gotoxy(1, 1);
    statusFrame.putmsg(padRight(text, statusFrame.width), BG_MAGENTA | WHITE);
    this.statusSignature = text;
  }

  private renderInput(): void {
    const inputFrame = this.frames.input;
    const viewportWidth = Math.max(1, this.frames.width - 2);
    const viewport = this.inputBuffer.getViewport(viewportWidth);
    const signature = this.inputBuffer.getValue() + "|" + String(viewport.cursorColumn) + "|" + String(this.frames.width);
    let cursorX = 0;
    let cursorChar = " ";

    if (!inputFrame) {
      return;
    }

    if (signature === this.inputSignature) {
      return;
    }

    inputFrame.clear(BG_BLACK | WHITE);
    inputFrame.gotoxy(1, 1);
    inputFrame.putmsg(">", YELLOW);
    inputFrame.putmsg(padRight(viewport.text, viewportWidth), WHITE);

    cursorX = viewport.cursorColumn + 1;
    if (viewport.cursorColumn <= viewport.text.length) {
      cursorChar = viewport.text.charAt(viewport.cursorColumn - 1);
    }
    inputFrame.setData(cursorX - 1, 0, cursorChar, BG_CYAN | BLACK, false);
    this.inputSignature = signature;
  }

  private renderActiveModal(): void {
    const signature = this.buildModalSignature();

    if (!this.modalState) {
      this.destroyModalFrames();
      return;
    }

    this.ensureModalFrames();

    if (!this.frames.overlay || !this.frames.modal) {
      return;
    }

    if (signature === this.modalSignature) {
      return;
    }

    renderModal(
      this.frames.overlay,
      this.frames.modal,
      this.modalState,
      {
        ownAlias: user.alias,
        ownUserNumber: user.number,
        avatarLib: this.avatarLib,
        avatarCache: this.avatarCache
      }
    );

    this.modalSignature = signature;
  }

  private buildTranscriptSignature(channel: ChatChannel | null): string {
    let lastMessage = "";
    let lastTime = 0;

    if (channel && channel.messages.length) {
      const message = channel.messages[channel.messages.length - 1];
      if (message) {
        lastMessage = message.str || "";
        lastTime = message.time || 0;
      }
    }

    return [
      String(this.frames.width),
      String(this.frames.height),
      this.currentChannel,
      String(!!this.chat),
      String(this.transcriptScrollOffsetBlocks),
      channel ? String(channel.messages.length) : "0",
      String(lastTime),
      lastMessage
    ].join("|");
  }

  private buildStatusText(): string {
    if (this.modalState) {
      switch (this.modalState.kind) {
        case "roster":
          return "Who's Here | Up/Down move | Esc close";
        case "channels":
          return "Channels | Enter switch | Esc close";
        case "help":
          return "Help | Esc close";
        default:
          break;
      }
    }

    if (!this.chat) {
      return this.buildDisconnectedText() + " | /connect | Esc exit";
    }

    if (this.transcriptScrollOffsetBlocks > 0) {
      return "History " + String(this.transcriptScrollOffsetBlocks) + " back | Up/PgUp older | Down/PgDn newer | End latest";
    }

    return "Up/PgUp history | /who /channels /help | /join /part /me /clear | Tab next | Esc exit";
  }

  private buildDisconnectedText(): string {
    let seconds = 0;

    if (this.reconnectAt) {
      seconds = Math.ceil((this.reconnectAt - new Date().getTime()) / 1000);
      if (seconds < 0) {
        seconds = 0;
      }
    }

    if (this.lastError.length) {
      return clipText(this.lastError, Math.max(10, this.frames.width - 16)) + " | retry " + String(seconds) + "s";
    }

    return "Disconnected";
  }

  private resetRenderSignatures(): void {
    this.transcriptSignature = "";
    this.headerSignature = "";
    this.actionSignature = "";
    this.statusSignature = "";
    this.inputSignature = "";
    this.modalSignature = "";
  }

  private buildModalSignature(): string {
    const parts: string[] = [];
    let index = 0;

    if (!this.modalState) {
      return "";
    }

    parts.push(this.modalState.kind);
    parts.push(this.modalState.title);
    parts.push(String(this.modalState.selectedIndex));
    parts.push(String(this.frames.width));
    parts.push(String(this.frames.height));

    if (this.modalState.kind === "help") {
      for (index = 0; index < this.modalState.lines.length; index += 1) {
        parts.push(this.modalState.lines[index] || "");
      }
      return parts.join("|");
    }

    for (index = 0; index < this.modalState.entries.length; index += 1) {
      const entry = this.modalState.entries[index];

      if (!entry) {
        continue;
      }

      if (this.modalState.kind === "roster") {
        const rosterEntry = entry as RosterEntry;
        parts.push(rosterEntry.name + "@" + rosterEntry.bbs + ":" + String(rosterEntry.isSelf));
        continue;
      }

      const channelEntry = entry as ChannelListEntry;
      parts.push(channelEntry.name + ":" + String(channelEntry.userCount) + ":" + String(channelEntry.isCurrent));
    }

    return parts.join("|");
  }
}
