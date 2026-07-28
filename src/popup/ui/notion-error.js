import { buildNotionDiagnostics } from '../notion/diagnostics.js';
import { NOTION_SESSION_VALIDATION_FAILED } from '../notion/page-info.js';

function isNotionAccessError(error) {
    const message = error?.message || '';
    return /Notion|页面信息|登录|权限|loadPageChunk|saveTransactions|syncRecordValues|recordMap|active user|HTTP 401|HTTP 403/i.test(message);
}

async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
}

export async function showErrorWithDiagnostics(error, pageId) {
    const status = document.getElementById('status');
    status.textContent = '';
    status.style.color = '';

    const isSessionValidationError = error?.code === NOTION_SESSION_VALIDATION_FAILED;
    if (isSessionValidationError) {
        const card = document.createElement('div');
        card.className = 'notion-session-card';

        const title = document.createElement('div');
        title.className = 'notion-session-title';
        title.textContent = 'Notion 登录信息可能已失效';
        card.appendChild(title);

        const description = document.createElement('div');
        description.className = 'notion-session-description';
        description.textContent = '虽然页面显示为已登录，但扩展未能验证该页面的访问权限。请清除 Notion 网站数据并重新登录。';
        card.appendChild(description);

        const helpButton = document.createElement('button');
        helpButton.type = 'button';
        helpButton.className = 'notion-session-help-btn';
        helpButton.textContent = '查看重新登录步骤';
        helpButton.addEventListener('click', () => {
            chrome.tabs.create({
                url: chrome.runtime.getURL('help/notion-session.html')
            });
        });
        card.appendChild(helpButton);

        status.appendChild(card);
    } else {
        const message = document.createElement('div');
        message.className = 'error-message';
        message.textContent = `❌ ${error.message}`;
        status.appendChild(message);
    }

    if (!pageId || !isNotionAccessError(error)) return;

    const hint = document.createElement('div');
    hint.className = 'diagnostic-hint';
    hint.textContent = '正在生成 Notion 诊断信息...';
    status.appendChild(hint);

    try {
        const report = await buildNotionDiagnostics(pageId);
        hint.textContent = isSessionValidationError
            ? '重新登录后仍然失败？请复制诊断信息反馈。'
            : 'Notion 权限或 API 异常，可复制诊断信息反馈。';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'diagnostic-btn';
        button.textContent = '复制诊断信息';
        button.addEventListener('click', async () => {
            try {
                await copyText(report);
                button.textContent = '已复制';
            } catch (copyError) {
                console.error(copyError);
                button.textContent = '复制失败';
            }
        });
        status.appendChild(button);
    } catch (diagnosticError) {
        console.warn('[link2notion] 生成 Notion 诊断信息失败:', diagnosticError);
        hint.textContent = `诊断信息生成失败：${diagnosticError.message}`;
    }
}
