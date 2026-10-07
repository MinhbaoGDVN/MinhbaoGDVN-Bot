import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const TICKET_GUILD_ID = '1518264520785527004';

const settingsPath = process.env.TICKET_SETTINGS_FILE || resolve(dirname(fileURLToPath(import.meta.url)), '../../ticket-settings.json');

export const DEFAULT_TICKET_SETTINGS = {
    guildId: TICKET_GUILD_ID,
    serverName: 'Cộng Đồng Cục Đất Bell Việt Nam',
    panelChannelId: '',
    panelMessageId: '',
    categoryId: '',
    staffRoleId: '',
    transcriptChannelId: '',
    panelTitle: 'Trung tâm hỗ trợ',
    panelDescription: 'Bạn cần trợ giúp? Chọn trao đổi riêng với moderator hoặc nhận hỗ trợ nhanh từ AI.',
    panelButtonLabel: 'Mở yêu cầu hỗ trợ',
    panelButtonEmoji: '🎫',
    color: '#2F8F83',
    ticketTitle: 'Yêu cầu hỗ trợ',
    ticketIntro: 'Cảm ơn bạn đã liên hệ. Hãy gửi mô tả rõ ràng và đính kèm thông tin cần thiết.',
    formEnabled: false,
    formMode: 'modal',
    formTitle: 'Thông tin hỗ trợ',
    formQuestions: [
        { label: 'Bạn cần hỗ trợ về vấn đề gì?', placeholder: 'Mô tả ngắn gọn vấn đề của bạn', required: true }
    ]
};

let cachedSettings;

function normalizeSettings(input, current = DEFAULT_TICKET_SETTINGS) {
    const values = { ...current, ...input, guildId: TICKET_GUILD_ID };
    const textFields = [
        ['serverName', 1, 100],
        ['panelTitle', 1, 256],
        ['panelDescription', 1, 4000],
        ['panelButtonLabel', 1, 80],
        ['panelButtonEmoji', 0, 20],
        ['ticketTitle', 1, 256],
        ['ticketIntro', 1, 4000],
        ['formTitle', 1, 45]
    ];

    for (const [key, min, max] of textFields) {
        if (typeof values[key] !== 'string' || values[key].length < min || values[key].length > max) {
            throw new Error(`Giá trị ${key} phải có độ dài từ ${min} đến ${max} ký tự.`);
        }
    }

    if (!/^#[0-9a-fA-F]{6}$/.test(values.color)) {
        throw new Error('Màu ticket phải là mã HEX gồm 6 ký tự, ví dụ #2F8F83.');
    }

    for (const key of ['panelChannelId', 'panelMessageId', 'categoryId', 'staffRoleId', 'transcriptChannelId']) {
        if (typeof values[key] !== 'string' || (values[key] && !/^\d{17,20}$/.test(values[key]))) {
            throw new Error(`ID ${key} không hợp lệ.`);
        }
    }

    if (typeof values.formEnabled !== 'boolean') {
        throw new Error('formEnabled phải là true hoặc false.');
    }
    if (!['modal', 'channel'].includes(values.formMode)) {
        throw new Error('formMode chỉ được là modal hoặc channel.');
    }
    const minimumQuestions = values.formEnabled ? 1 : 0;
    if (!Array.isArray(values.formQuestions) || values.formQuestions.length < minimumQuestions || values.formQuestions.length > 5) {
        throw new Error(values.formEnabled ? 'Form đang bật nên cần từ 1 đến 5 câu hỏi.' : 'Form tối đa 5 câu hỏi.');
    }

    values.formQuestions = values.formQuestions.map((question, index) => {
        if (!question || typeof question.label !== 'string' || question.label.trim().length < 1 || question.label.length > 45) {
            throw new Error(`Nhãn câu hỏi ${index + 1} cần từ 1 đến 45 ký tự.`);
        }
        if (typeof question.placeholder !== 'string' || question.placeholder.length > 100) {
            throw new Error(`Gợi ý câu hỏi ${index + 1} không được vượt 100 ký tự.`);
        }
        if (typeof question.required !== 'boolean') {
            throw new Error(`Câu hỏi ${index + 1} cần có trạng thái bắt buộc hợp lệ.`);
        }

        return {
            label: question.label.trim(),
            placeholder: question.placeholder.trim(),
            required: question.required
        };
    });

    return values;
}

export async function validateTicketSettings(input) {
    const current = await loadTicketSettings();
    return normalizeSettings(input, current);
}

export async function loadTicketSettings() {
    if (cachedSettings) return { ...cachedSettings, formQuestions: [...cachedSettings.formQuestions] };

    try {
        const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
        cachedSettings = normalizeSettings(saved);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Không đọc được ticket-settings.json, dùng cấu hình mặc định:', error);
        }
        cachedSettings = {
            ...DEFAULT_TICKET_SETTINGS,
            formQuestions: [...DEFAULT_TICKET_SETTINGS.formQuestions]
        };
    }

    return { ...cachedSettings, formQuestions: [...cachedSettings.formQuestions] };
}

export async function saveTicketSettings(input) {
    const current = await loadTicketSettings();
    const normalized = normalizeSettings(input, current);

    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, settingsPath);
    cachedSettings = normalized;

    return { ...cachedSettings, formQuestions: [...cachedSettings.formQuestions] };
}
