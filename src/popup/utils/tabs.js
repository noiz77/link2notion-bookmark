export async function getActiveTab() {
    const queryAttempts = [
        { active: true, currentWindow: true },
        { active: true, lastFocusedWindow: true },
        { active: true }
    ];

    for (const queryInfo of queryAttempts) {
        const tabs = await chrome.tabs.query(queryInfo);
        const tab = tabs.find(t => typeof t.id === 'number');
        if (tab) return tab;
    }

    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    for (const win of windows) {
        const tab = (win.tabs || []).find(t => t.active && typeof t.id === 'number');
        if (tab) return tab;
    }

    return null;
}
