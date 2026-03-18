export interface ActionBarAction {
  id: string;
  label: string;
}

export const ACTION_BAR_ACTIONS: ActionBarAction[] = [
  { id: "who", label: "/who" },
  { id: "channels", label: "/channels" },
  { id: "help", label: "/help" },
  { id: "next", label: "Tab next" },
  { id: "exit", label: "Esc exit" }
];

export interface RosterEntry {
  name: string;
  bbs: string;
  nick: ChatNick | null;
  isSelf: boolean;
}

export interface ChannelListEntry {
  name: string;
  userCount: number;
  isCurrent: boolean;
  metaText?: string;
}

interface BaseModalState {
  title: string;
  selectedIndex: number;
}

export interface RosterModalState extends BaseModalState {
  kind: "roster";
  entries: RosterEntry[];
}

export interface ChannelsModalState extends BaseModalState {
  kind: "channels";
  entries: ChannelListEntry[];
}

export interface HelpModalState extends BaseModalState {
  kind: "help";
  lines: string[];
}

export type AppModalState = RosterModalState | ChannelsModalState | HelpModalState;
