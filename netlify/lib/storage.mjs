import { getStore } from "@netlify/blobs";

function strongStore(name) {
  return getStore({ name, consistency: "strong" });
}

export const stores = {
  users: () => strongStore("smart-usb-users"),
  sessions: () => strongStore("smart-usb-sessions"),
  devices: () => strongStore("smart-usb-devices"),
  events: () => strongStore("smart-usb-events"),
  connections: () => strongStore("smart-usb-connections"),
};

export async function getJson(store, key) {
  return await store.get(key, { type: "json", consistency: "strong" });
}

export async function putJson(store, key, value, options = {}) {
  return await store.setJSON(key, value, options);
}

export async function listJson(store, prefix = "") {
  const { blobs } = await store.list({ prefix });
  const values = await Promise.all(
    blobs.map((entry) => getJson(store, entry.key)),
  );
  return values.filter(Boolean);
}

export async function deleteByPrefix(store, prefix) {
  const { blobs } = await store.list({ prefix });
  await Promise.all(blobs.map((entry) => store.delete(entry.key)));
  return blobs.length;
}
