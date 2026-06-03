// 从 cookie 读取当前 Notion 用户 ID

export async function getCurrentUserId() {
    const urls = ["https://www.notion.so", "https://app.notion.com"];
    for (const url of urls) {
        const cookie = await chrome.cookies.get({ url, name: "notion_user_id" });
        if (cookie?.value) return cookie.value;
    }
    return null;
}
