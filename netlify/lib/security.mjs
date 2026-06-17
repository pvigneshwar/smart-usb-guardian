import {
  createHash,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "pbkdf2_sha256";
const ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const SESSION_DAYS = 7;

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error("Enter a valid email address.");
    error.status = 422;
    throw error;
  }
  return email;
}

export function hashPassword(password) {
  const value = String(password || "");
  if (!value) {
    const error = new Error("Password cannot be empty.");
    error.status = 422;
    throw error;
  }
  if (value.length > 200) {
    const error = new Error("Password cannot exceed 200 characters.");
    error.status = 422;
    throw error;
  }

  const salt = randomBytes(16);
  const derived = pbkdf2Sync(value, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return `${ALGORITHM}$${ITERATIONS}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password, storedHash) {
  try {
    const [algorithm, iterationsText, saltHex, expectedHex] = String(
      storedHash || "",
    ).split("$");
    if (algorithm !== ALGORITHM) return false;

    const iterations = Number(iterationsText);
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(expectedHex, "hex");
    if (!Number.isInteger(iterations) || iterations <= 0) return false;
    if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;

    const actual = pbkdf2Sync(
      String(password || ""),
      salt,
      iterations,
      KEY_LENGTH,
      DIGEST,
    );
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashToken(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

export function issueToken() {
  const accessToken = randomBytes(40).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(
    createdAt.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  );
  return {
    accessToken,
    tokenHash: hashToken(accessToken),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export function createId() {
  return randomUUID();
}

export function createDeviceUid() {
  return `USB-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function createEventId() {
  // Numeric IDs preserve compatibility with the current dashboard checkboxes.
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

export function emailIndexKey(email) {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}
