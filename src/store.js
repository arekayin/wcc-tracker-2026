// Last known state, so the popup is never empty when the network is down.
// chrome.storage.local in the extension; localStorage when the page is opened directly.
const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

export async function load(key) {
  try {
    if (hasChrome) return (await chrome.storage.local.get(key))[key] ?? null;
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

export async function save(key, value) {
  try {
    if (hasChrome) await chrome.storage.local.set({ [key]: value });
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Storage full or unavailable: the popup still works, it just won't remember.
  }
}
