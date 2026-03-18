export interface AvatarCache {
  [key: string]: string | null;
}

export interface AvatarDimensions {
  width: number;
  height: number;
}

export function resolveAvatarDimensions(avatarLib: AvatarLibrary | null): AvatarDimensions {
  if (avatarLib && avatarLib.defs) {
    return {
      width: avatarLib.defs.width || 10,
      height: avatarLib.defs.height || 6
    };
  }

  return {
    width: 10,
    height: 6
  };
}

function avatarCacheKey(nick: ChatNick, ownAlias: string): string {
  const remoteKey = resolveAvatarNetaddr(nick) || nick.host || "local";

  if (nick.name.toUpperCase() === ownAlias.toUpperCase()) {
    return "local:" + nick.name.toUpperCase();
  }
  return nick.name.toUpperCase() + "@" + String(remoteKey).toUpperCase();
}

function normalizeQwkId(qwkid: string | undefined): string | null {
  if (!qwkid) {
    return null;
  }

  qwkid = String(qwkid);
  if (!qwkid.length) {
    return null;
  }

  return qwkid.toUpperCase();
}

function resolveAvatarNetaddr(nick: ChatNick): string | null {
  const qwkid = normalizeQwkId(nick.qwkid);

  if (qwkid) {
    return qwkid;
  }

  return nick.host || null;
}

export function lookupAvatarBinary(
  avatarLib: AvatarLibrary | null,
  nick: ChatNick | null,
  ownAlias: string,
  ownUserNumber: number,
  cache: AvatarCache
): string | null {
  let cached;
  let avatarObj;
  let decoded;
  let localUserNumber;
  let localQwkId;
  let nickQwkId;
  let netaddr;
  let key = "";

  if (!avatarLib || !nick || !nick.name) {
    return null;
  }

  key = avatarCacheKey(nick, ownAlias);
  cached = cache[key];
  if (cached !== undefined) {
    return cached;
  }

  avatarObj = null;

  try {
    localQwkId = normalizeQwkId(system.qwk_id);
    nickQwkId = normalizeQwkId(nick.qwkid);
    netaddr = resolveAvatarNetaddr(nick);

    if (nick.name.toUpperCase() === ownAlias.toUpperCase()) {
      avatarObj = avatarLib.read(ownUserNumber, ownAlias, null, null) || null;
    } else {
      localUserNumber = 0;

      if (!nickQwkId || nickQwkId === localQwkId) {
        localUserNumber = system.matchuser(nick.name);
      }

      if (localUserNumber > 0) {
        avatarObj = avatarLib.read(localUserNumber, nick.name, null, null) || null;
      } else {
        avatarObj = avatarLib.read(0, nick.name, netaddr, nick.host || null) || null;
      }
    }
  } catch (_error) {
    avatarObj = null;
  }

  if (!avatarObj || avatarObj.disabled || !avatarObj.data) {
    cache[key] = null;
    return null;
  }

  try {
    decoded = base64_decode(avatarObj.data);
  } catch (_decodeError) {
    decoded = null;
  }

  decoded = decoded || null;
  cache[key] = decoded;
  return decoded;
}

export function blitAvatarToFrame(
  frame: Frame,
  avatarBinary: string,
  avatarWidth: number,
  avatarHeight: number,
  x: number,
  y: number
): void {
  let offset = 0;
  let row = 0;

  for (row = 0; row < avatarHeight; row += 1) {
    let column = 0;

    for (column = 0; column < avatarWidth; column += 1) {
      let ch = "";
      let attr = 0;

      if (x + column > frame.width || y + row > frame.height) {
        offset += 2;
        continue;
      }

      if (offset + 1 >= avatarBinary.length) {
        return;
      }

      ch = avatarBinary.substr(offset, 1);
      attr = ascii(avatarBinary.substr(offset + 1, 1));
      frame.setData(x + column - 1, y + row - 1, ch, attr, false);
      offset += 2;
    }
  }
}
