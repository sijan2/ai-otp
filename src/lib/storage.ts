export class Storage {
  public async get<T = any>(key: string): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] ?? null);
      });
    });
  }

  public async set<T>(key: string, value: T): Promise<void> {
    return new Promise<void>((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    });
  }

  public async remove(key: string): Promise<void> {
    return new Promise<void>((resolve) => {
      chrome.storage.local.remove(key, () => resolve());
    });
  }

  public async clear(): Promise<void> {
    return new Promise<void>((resolve) => {
      chrome.storage.local.clear(() => resolve());
    });
  }
}
