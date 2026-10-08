import http from 'http';
import { timingSafeEqual } from 'crypto';
import { format } from 'node:util';
import { ChannelType } from 'discord.js';
import { loadTicketSettings, saveTicketSettings } from '../ticket/ticket-settings.js';
import { publishTicketPanel, TICKET_GUILD_ID } from '../ticket/ticket-handler.js';
import { getTicketActivity } from '../ticket/ticket-activity.js';

const MAX_LOGS = 1000;
const logs = [];
const clients = [];

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function addLog(message, type = 'INFO') {
    const log = {
        time: new Date().toISOString(),
        type,
        message: String(message)
    };

    logs.push(log);

    if (logs.length > MAX_LOGS) {
        logs.shift();
    }

    const data = `data: ${JSON.stringify(log)}\n\n`;

    clients.forEach(client => {
        try {
            client.write(data);
        } catch (error) {
            originalError('Lỗi gửi live log:', error);
        }
    });
}

console.log = (...args) => {
    addLog(format(...args), 'INFO');
    originalLog(...args);
};

console.error = (...args) => {
    addLog(format(...args), 'ERROR');
    originalError(...args);
};

console.warn = (...args) => {
    addLog(format(...args), 'WARN');
    originalWarn(...args);
};

function sendJSON(res, statusCode, value) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(value));
}

async function readJSONBody(req) {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024) throw new Error('Request vượt quá 32 KB.');
        chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isAuthorized(req, suppliedPassword) {
    const expectedPassword = process.env.DASHBOARD_PASSWORD;
    if (!expectedPassword || typeof suppliedPassword !== 'string') return false;

    const expected = Buffer.from(expectedPassword);
    const supplied = Buffer.from(suppliedPassword);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function ticketOptions(client) {
    const guild = client.guilds.cache.get(TICKET_GUILD_ID) ?? await client.guilds.fetch(TICKET_GUILD_ID);

    return {
        channels: guild.channels.cache
            .filter(channel => channel.type === ChannelType.GuildText)
            .map(channel => ({ id: channel.id, name: channel.name }))
            .sort((first, second) => first.name.localeCompare(second.name)),
        categories: guild.channels.cache
            .filter(channel => channel.type === ChannelType.GuildCategory)
            .map(channel => ({ id: channel.id, name: channel.name }))
            .sort((first, second) => first.name.localeCompare(second.name)),
        roles: guild.roles.cache
            .filter(role => !role.managed && role.id !== guild.id)
            .map(role => ({ id: role.id, name: role.name }))
            .sort((first, second) => first.name.localeCompare(second.name))
    };
}

async function dashboardSnapshot(client) {
    const guild = client.guilds.cache.get(TICKET_GUILD_ID) ?? await client.guilds.fetch(TICKET_GUILD_ID);

    const tickets = guild.channels.cache
        .filter(channel => channel.type === ChannelType.GuildText && /ticket-owner:\d+/.test(channel.topic || ''))
        .map(channel => {
            const ownerId = channel.topic.match(/ticket-owner:(\d+)/)?.[1] || '';
            const claimedBy = channel.topic.match(/ticket-claimed-by:(\d+)/)?.[1] || '';
            const supportMode = channel.topic.match(/ticket-support:(ai|moderator)/)?.[1] || 'moderator';
            const closed = channel.name.startsWith('closed-');

            return {
                id: channel.id,
                name: channel.name,
                ownerId,
                supportMode,
                claimedBy,
                status: closed ? 'Đã đóng' : supportMode === 'ai' ? 'AI đang hỗ trợ' : claimedBy ? 'Đang xử lý' : 'Chờ moderator',
                closed,
                createdAt: new Date(channel.createdTimestamp).toISOString(),
                url: `https://discord.com/channels/${guild.id}/${channel.id}`
            };
        })
        .sort((first, second) => second.createdAt.localeCompare(first.createdAt));

    const events = getTicketActivity();
    const today = new Date();
    const activity = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 6 + index));
        const key = date.toISOString().slice(0, 10);
        const dailyEvents = events.filter(event => event.at.slice(0, 10) === key);

        return {
            date: key,
            created: dailyEvents.filter(event => event.action === 'created').length,
            deleted: dailyEvents.filter(event => event.action === 'deleted').length,
            claimed: dailyEvents.filter(event => event.action === 'claimed').length
        };
    });

    const openTickets = tickets.filter(ticket => !ticket.closed);
    return {
        generatedAt: new Date().toISOString(),
        stats: {
            open: openTickets.length,
            ai: openTickets.filter(ticket => ticket.supportMode === 'ai').length,
            moderator: openTickets.filter(ticket => ticket.supportMode === 'moderator').length,
            waiting: openTickets.filter(ticket => ticket.status === 'Chờ moderator').length,
            claimed: openTickets.filter(ticket => Boolean(ticket.claimedBy)).length,
            events: events.length
        },
        tickets,
        activity,
        recentEvents: events.slice(0, 12)
    };
}

function createDashboardServer(client) {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');

        if (url.pathname === '/health' && req.method === 'GET') {
            return sendJSON(res, 200, { status: 'ok' });
        }

        if (url.pathname === '/api/auth' && req.method === 'POST') {
            try {
                const body = await readJSONBody(req);
                if (!process.env.DASHBOARD_PASSWORD) {
                    return sendJSON(res, 503, { error: 'Chưa cấu hình DASHBOARD_PASSWORD trong .env.' });
                }
                return isAuthorized(req, body.password)
                    ? sendJSON(res, 200, { ok: true })
                    : sendJSON(res, 401, { error: 'Mật khẩu không đúng.' });
            } catch (error) {
                return sendJSON(res, 400, { error: error.message || 'Request không hợp lệ.' });
            }
        }

        if (url.pathname.startsWith('/api/')) {
            if (!process.env.DASHBOARD_PASSWORD) {
                return sendJSON(res, 503, { error: 'Chưa cấu hình DASHBOARD_PASSWORD trong .env.' });
            }
            if (!isAuthorized(req, req.headers['x-dashboard-password'])) {
                return sendJSON(res, 401, { error: 'Cần đăng nhập lại để quản lý ticket.' });
            }

            try {
                if (url.pathname === '/api/ticket-settings' && req.method === 'GET') {
                    return sendJSON(res, 200, await loadTicketSettings());
                }
                if (url.pathname === '/api/ticket-settings' && req.method === 'POST') {
                    return sendJSON(res, 200, await saveTicketSettings(await readJSONBody(req)));
                }
                if (url.pathname === '/api/ticket-options' && req.method === 'GET') {
                    return sendJSON(res, 200, await ticketOptions(client));
                }
                if (url.pathname === '/api/dashboard' && req.method === 'GET') {
                    return sendJSON(res, 200, await dashboardSnapshot(client));
                }
                if (url.pathname === '/api/status' && req.method === 'GET') {
                    return sendJSON(res, 200, {
                        ready: client.isReady(),
                        user: client.user?.tag || null,
                        guildAvailable: client.guilds.cache.has(TICKET_GUILD_ID),
                        ping: client.ws.ping,
                        uptime: process.uptime()
                    });
                }
                if (url.pathname === '/api/ticket-panel' && req.method === 'POST') {
                    return sendJSON(res, 200, await publishTicketPanel(client, await readJSONBody(req)));
                }

                return sendJSON(res, 404, { error: 'API không tồn tại.' });
            } catch (error) {
                console.error('Lỗi dashboard API:', error);
                return sendJSON(res, 400, { error: error.message || 'Không thể xử lý cấu hình ticket.' });
            }
        }

        if (url.pathname === '/logs' && req.method === 'GET') {
            if (!process.env.DASHBOARD_PASSWORD) {
                return sendJSON(res, 503, { error: 'Chưa cấu hình DASHBOARD_PASSWORD.' });
            }
            if (!isAuthorized(req, req.headers['x-dashboard-password'])) {
                return sendJSON(res, 401, { error: 'Cần đăng nhập để xem nhật ký.' });
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });

            clients.push(res);

            for (const log of logs) {
                res.write(`data: ${JSON.stringify(log)}\n\n`);
            }

            const removeClient = () => {
                const index = clients.indexOf(res);

                if (index !== -1) {
                    clients.splice(index, 1);
                }
            };
            res.on('close', removeClient);
            res.on('error', removeClient);

            return;
        }

        if (url.pathname === '/' && req.method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8'
            });
            res.end(getDashboardHTML());
            return;
        }

        res.writeHead(404);
        res.end('Not Found');
    });
}

function getDashboardHTML() {
    return `
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ticket Desk | MinhbaoGDVN</title>
    <style>
        :root{font-family:"DM Sans","Segoe UI",sans-serif;color:#172522;background:#f1f4f0;font-synthesis:none;text-rendering:optimizeLegibility;--ink:#172522;--muted:#66736e;--line:#dce4df;--paper:#fff;--forest:#174d42;--lime:#d9f36a;--coral:#d96f55;--soft:#e8efeb}
        *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 90% 0%,#e4eee4 0,transparent 36%),#f1f4f0}button,input,textarea,select{font:inherit}button{cursor:pointer}
        .shell{min-height:100vh;display:grid;grid-template-columns:230px minmax(0,1fr)}.rail{background:var(--ink);color:#f5f7f2;padding:25px 17px;display:flex;flex-direction:column;gap:32px}.brand{display:flex;gap:11px;align-items:center;padding:3px 8px}.brand-mark{width:35px;height:35px;border-radius:11px;background:var(--lime);color:var(--ink);display:grid;place-items:center;font-size:18px;font-weight:900}.brand-name{font-size:13px;font-weight:750;line-height:1.25}.brand-name small{display:block;color:#aab8b0;font-weight:500;margin-top:4px}.nav{display:grid;gap:7px}.nav button{border:0;text-align:left;color:#b9c5be;background:transparent;border-radius:8px;padding:12px 13px;font-weight:650}.nav button.active,.nav button:hover{background:#2b3933;color:#fff}.nav button.active:before{content:"";display:inline-block;width:6px;height:6px;background:var(--lime);border-radius:50%;margin:0 11px 2px 0}.rail-foot{margin-top:auto;color:#8d9a93;font-size:12px;line-height:1.6;padding:8px}
        main{min-width:0;padding:36px clamp(18px,4vw,56px) 60px;max-width:1500px;width:100%;margin:auto}.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:27px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;color:var(--forest);font-size:11px;font-weight:800}.topbar h1{font-size:29px;margin:8px 0 5px;line-height:1.15}.subtitle{margin:0;color:var(--muted);font-size:14px}.connection{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:99px;padding:8px 12px;white-space:nowrap}.dot{width:8px;height:8px;border-radius:50%;background:#8aa39a}.dot.live{background:#47a176;box-shadow:0 0 0 3px #e4f2e9}
        .view{display:none}.view.active{display:block}.layout{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(260px,.75fr);gap:22px;align-items:start}.column{display:grid;gap:17px}.section{background:var(--paper);border:1px solid var(--line);border-radius:9px;padding:20px}.section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:17px}.section h2{font-size:15px;margin:0 0 4px}.section-head p,.help{font-size:12px;color:var(--muted);margin:0;line-height:1.5}.section-index{font-size:11px;color:#73827b;font-weight:750;white-space:nowrap}
        .fields{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{display:grid;gap:6px;min-width:0}.field.wide{grid-column:1/-1}.field label,.control-label{font-size:12px;font-weight:700;color:#3a4842}.field input,.field textarea,.field select,.question input[type=text]{width:100%;border:1px solid #cfd9d3;border-radius:6px;padding:10px 11px;background:#fff;color:var(--ink);outline:none}.field textarea{resize:vertical;min-height:88px;line-height:1.45}.field input:focus,.field textarea:focus,.field select:focus,.question input:focus{border-color:#4d8c7b;box-shadow:0 0 0 3px #e4f0eb}.field small{font-size:11px;color:var(--muted)}
        .color-row{display:flex;gap:8px}.color-row input[type=color]{width:43px;height:40px;padding:3px;border:1px solid #cfd9d3;border-radius:6px;background:white}.color-row input[type=text]{flex:1}.segmented{display:flex;padding:3px;background:#eef2ee;border-radius:7px;gap:3px}.segmented button{border:0;background:transparent;color:#58665f;border-radius:5px;padding:8px 10px;font-size:12px;font-weight:700;flex:1}.segmented button.selected{background:#fff;color:var(--forest);box-shadow:0 1px 4px #18291c1a}.switch-line{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:12px 0;border-bottom:1px solid #edf0ed}.switch-line:last-child{border-bottom:0}.switch-line strong{font-size:13px}.switch-line small{display:block;color:var(--muted);font-size:11px;margin-top:3px}.switch{appearance:none;width:39px;height:23px;border-radius:99px;background:#c4cec8;position:relative;transition:background .16s;flex:none}.switch:after{content:"";width:17px;height:17px;border-radius:50%;background:white;position:absolute;top:3px;left:3px;transition:transform .16s}.switch:checked{background:var(--forest)}.switch:checked:after{transform:translateX(16px)}
        .questions{display:grid;gap:10px}.question{border:1px solid var(--line);border-radius:7px;padding:12px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center}.question-main{display:grid;gap:8px;min-width:0}.question input[type=text]{font-size:12px;padding:8px}.question-meta{display:flex;gap:12px;align-items:center}.question-meta label{display:flex;align-items:center;gap:5px;color:var(--muted);font-size:11px}.question-meta input{accent-color:var(--forest)}.icon-button{width:33px;height:33px;border:1px solid var(--line);background:#fff;border-radius:6px;color:#69756e;font-weight:800}.icon-button:hover{border-color:var(--coral);color:var(--coral)}.add-question{margin-top:10px;border:1px dashed #b8c6bd;background:#f8faf8;border-radius:6px;color:var(--forest);padding:9px 11px;font-size:12px;font-weight:750}
        .preview-sticky{position:sticky;top:20px}.preview-label{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;font-weight:750;text-transform:uppercase}.discord-card{margin-top:13px;background:#313338;color:#dbdee1;border-radius:8px;padding:15px;border-left:4px solid var(--forest);font-family:"Segoe UI",sans-serif}.discord-server{font-size:11px;color:#b5bac1;margin-bottom:8px}.discord-card h3{color:#fff;font-size:16px;margin:0 0 8px}.discord-card p{font-size:13px;line-height:1.45;white-space:pre-wrap;margin:0 0 13px}.discord-action{display:inline-flex;align-items:center;gap:7px;background:#5865f2;color:white;border-radius:4px;padding:8px 12px;font-size:12px;font-weight:650}.preview-ticket{margin-top:15px;border-top:1px solid #ffffff20;padding-top:12px}.preview-ticket b{display:block;color:white;font-size:13px;margin-bottom:5px}.preview-ticket span{font-size:11px;color:#b5bac1}
        .actions{position:sticky;bottom:12px;display:flex;justify-content:flex-end;gap:9px;padding:12px;background:#f1f4f0eb;backdrop-filter:blur(8px);border:1px solid var(--line);border-radius:9px;margin-top:17px}.button{border:1px solid var(--line);border-radius:6px;padding:10px 13px;background:white;color:var(--ink);font-size:12px;font-weight:750}.button.primary{background:var(--forest);border-color:var(--forest);color:white}.button.primary:hover{background:#206354}.button:disabled{opacity:.5;cursor:wait}.notice{display:none;padding:10px 12px;border-radius:6px;font-size:12px;margin-bottom:15px}.notice.show{display:block}.notice.error{background:#fff0ed;color:#9b3f2d}.notice.success{background:#e9f5eb;color:#286344}
        #logs{max-height:calc(100vh - 190px);overflow:auto;background:#16211d;color:#dce7df;border-radius:8px;padding:8px 14px;font:12px/1.55 Consolas,monospace}.log{padding:7px 2px;border-bottom:1px solid #29362f;white-space:pre-wrap;overflow-wrap:anywhere}.time{color:#98a9a0}.info{color:#a6d5bc}.warn{color:#f0ca72}.error{color:#f28d7b}
        .auth-screen{position:fixed;inset:0;z-index:10;display:grid;place-items:center;background:#172522eF;padding:20px}.auth-box{width:min(420px,100%);background:white;padding:26px;border-radius:10px;box-shadow:0 20px 70px #101a1640}.auth-box h2{margin:0 0 7px}.auth-box p{color:var(--muted);font-size:13px;line-height:1.5}.auth-box .field{margin:17px 0}.auth-warning{font-size:11px;color:#875c26;background:#fff5df;padding:10px;border-radius:6px}.hidden{display:none!important}
        @media(max-width:900px){.layout{grid-template-columns:1fr}.preview-sticky{position:static}.shell{grid-template-columns:190px minmax(0,1fr)}main{padding:25px 20px 50px}}
        @media(max-width:640px){.shell{display:block}.rail{padding:12px 14px;gap:11px}.brand{padding:0 2px}.nav{display:flex}.nav button{flex:1;padding:9px 10px}.rail-foot{display:none}main{padding:22px 14px 40px}.topbar{align-items:center}.topbar h1{font-size:23px}.connection{font-size:0;padding:9px}.connection .dot{margin:0}.fields{grid-template-columns:1fr}.field.wide{grid-column:auto}.section{padding:16px}.actions{bottom:6px}.actions .button{flex:1}.actions .button:last-child{flex:1.4}}
    </style>
    <style>
        .dashboard-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.dashboard-toolbar small{color:var(--muted);font-size:11px}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.metric{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:16px;min-width:0}.metric span{display:block;color:var(--muted);font-size:12px}.metric strong{display:block;margin-top:8px;font-size:27px;line-height:1}.metric em{display:block;margin-top:7px;color:var(--muted);font-size:11px;font-style:normal}.overview-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(250px,.8fr);gap:16px}.activity-chart{height:185px;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));align-items:end;gap:10px;padding:18px 4px 0}.chart-day{min-width:0;display:grid;grid-template-rows:1fr auto;align-items:end;gap:8px;height:100%;text-align:center}.chart-bars{height:142px;display:flex;align-items:end;justify-content:center;gap:3px;border-bottom:1px solid var(--line)}.activity-bar{width:min(18px,28%);min-height:0;border-radius:3px 3px 0 0;transition:height .2s}.activity-bar.created{background:#377e6d}.activity-bar.deleted{background:#d2765b}.activity-bar.claimed{background:#b9ce57}.chart-day label{font-size:10px;color:var(--muted)}.chart-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:13px;color:var(--muted);font-size:11px}.chart-legend span{display:flex;align-items:center;gap:6px}.legend-dot{width:8px;height:8px;border-radius:2px}.breakdown{display:grid;gap:15px;margin-top:18px}.break-row{display:grid;grid-template-columns:90px 1fr 28px;align-items:center;gap:9px;font-size:12px}.break-track{height:8px;background:#edf1ed;border-radius:8px;overflow:hidden}.break-fill{height:100%;border-radius:8px;background:var(--forest)}.break-fill.ai{background:#b9ce57}.break-count{text-align:right;font-variant-numeric:tabular-nums}.activity-feed{display:grid;gap:0;margin-top:8px}.activity-item{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid #edf0ed;font-size:12px}.activity-item:last-child{border-bottom:0}.activity-item strong{font-weight:650}.activity-item small{display:block;color:var(--muted);margin-top:3px}.data-tools{display:flex;gap:9px;align-items:center;margin:0 0 14px}.data-tools input,.data-tools select{border:1px solid #cfd9d3;border-radius:6px;padding:9px 10px;background:white;color:var(--ink);font:inherit;font-size:12px}.data-tools input{flex:1;min-width:130px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:7px}table{width:100%;border-collapse:collapse;text-align:left;font-size:12px;min-width:690px}th,td{padding:11px 12px;border-bottom:1px solid #edf0ed;white-space:nowrap}th{background:#f7f9f7;color:var(--muted);font-size:10px;text-transform:uppercase;font-weight:750}tbody tr:last-child td{border-bottom:0}.table-link{color:var(--forest);font-weight:700;text-decoration:none}.table-link:hover{text-decoration:underline}.status-tag{display:inline-block;border-radius:4px;padding:4px 7px;background:#f1f3e4;color:#66742e;font-size:10px}.status-tag.closed{background:#f1efed;color:#78716b}.empty-row{text-align:center;color:var(--muted);padding:26px}.flow-track{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:18px 0}.flow-step{position:relative;min-height:136px;padding:15px;border:1px solid var(--line);border-radius:7px;background:#fbfcfb}.flow-step b{display:grid;place-items:center;width:25px;height:25px;margin-bottom:14px;border-radius:50%;background:#e6efe9;color:var(--forest);font-size:11px}.flow-step strong{display:block;font-size:13px}.flow-step p{margin:6px 0 0;color:var(--muted);font-size:11px;line-height:1.5}.flow-note{border-left:3px solid var(--lime);padding:10px 12px;background:#f6f8ee;color:#485241;font-size:12px;line-height:1.5}.dashboard-error{display:none;margin-bottom:12px}.dashboard-error.show{display:block}
        @media(max-width:900px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-grid{grid-template-columns:1fr}.flow-track{grid-template-columns:repeat(2,minmax(0,1fr))}}
        @media(max-width:640px){.dashboard-toolbar{align-items:flex-start;flex-wrap:wrap}.metric{padding:13px}.metric strong{font-size:23px}.flow-track{grid-template-columns:1fr}.flow-step{min-height:0}.data-tools{align-items:stretch;flex-direction:column}.activity-chart{gap:4px}.chart-bars{gap:2px}.chart-legend{gap:8px}}
    </style>
</head>
<body>
    <section id="authScreen" class="auth-screen">
        <form id="authForm" class="auth-box">
            <div class="eyebrow">MinhbaoGDVN · Bot console</div>
            <h2>Đăng nhập quản trị</h2>
            <p>Cần mật khẩu dashboard để thay đổi cấu hình ticket.</p>
            <div class="field"><label for="password">Mật khẩu dashboard</label><input id="password" type="password" required autocomplete="current-password"></div>
            <div id="authError" class="notice error"></div>
            <button class="button primary" type="submit">Đăng nhập</button>
            <p class="auth-warning">Không công khai dashboard qua HTTP. Nếu truy cập từ Internet, hãy dùng HTTPS/reverse proxy.</p>
        </form>
    </section>
    <div id="app" class="shell hidden">
        <aside class="rail">
            <div class="brand"><div class="brand-mark">B</div><div class="brand-name">MinhbaoGDVN<small>Bot control desk</small></div></div>
            <nav class="nav">
                <button class="active" data-view="analytics">Phân tích</button>
                <button data-view="data">Dữ liệu</button>
                <button data-view="flow">Luồng</button>
                <button data-view="controls">Điều khiển</button>
                <button data-view="logs">Nhật ký</button>
            </nav>
            <div class="rail-foot">Cộng Đồng Cục Đất Bell Việt Nam<br><span id="guildId"></span></div>
        </aside>
        <main>
            <div class="topbar">
                <div><div class="eyebrow">Server operations</div><h1 id="pageTitle">Phân tích</h1><p class="subtitle" id="pageSubtitle">Tình hình ticket và hoạt động của bot trong phiên hiện tại.</p></div>
                <div class="connection"><span id="statusDot" class="dot"></span><span id="statusText">Đang kết nối</span></div>
            </div>
            <section id="analyticsView" class="view active">
                <div id="dashboardError" class="notice error dashboard-error"></div>
                <div class="dashboard-toolbar"><small id="dashboardUpdated">Đang tải số liệu…</small><button id="refreshDashboard" class="button" type="button">Làm mới dữ liệu</button></div>
                <div class="metric-grid">
                    <article class="metric"><span>Ticket đang mở</span><strong id="metricOpen">—</strong><em id="metricWaiting">— chờ moderator</em></article>
                    <article class="metric"><span>AI nhanh</span><strong id="metricAI">—</strong><em>đang hoạt động</em></article>
                    <article class="metric"><span>Moderator</span><strong id="metricModerator">—</strong><em id="metricClaimed">— đã nhận xử lý</em></article>
                    <article class="metric"><span>Sự kiện trong phiên</span><strong id="metricEvents">—</strong><em>từ khi bot khởi động</em></article>
                </div>
                <div class="overview-grid">
                    <section class="section"><div class="section-head"><div><h2>Hoạt động 7 ngày</h2><p>Ghi nhận từ lúc bot khởi động, tối đa 500 sự kiện.</p></div><span class="section-index">LIVE</span></div><div id="activityChart" class="activity-chart" role="img" aria-label="Biểu đồ tạo, nhận và xóa ticket"></div><div class="chart-legend"><span><i class="legend-dot" style="background:#377e6d"></i>Tạo ticket</span><span><i class="legend-dot" style="background:#b9ce57"></i>Moderator nhận</span><span><i class="legend-dot" style="background:#d2765b"></i>Xóa ticket</span></div></section>
                    <section class="section"><div class="section-head"><div><h2>Phân bổ hỗ trợ</h2><p>Ticket đang mở theo kênh xử lý.</p></div><span class="section-index">MIX</span></div><div id="modeBreakdown" class="breakdown"></div></section>
                </div>
                <section class="section" style="margin-top:16px"><div class="section-head"><div><h2>Hoạt động gần đây</h2><p>Các sự kiện ticket mới nhất trong phiên bot.</p></div><span class="section-index">EVENTS</span></div><div id="recentActivity" class="activity-feed"></div></section>
            </section>
            <section id="dataView" class="view">
                <div class="dashboard-toolbar"><small id="ticketDataUpdated">Ticket channels đọc trực tiếp từ Discord.</small><button class="button" type="button" data-refresh-dashboard>Làm mới</button></div>
                <div class="data-tools"><input id="ticketSearch" type="search" placeholder="Tìm theo channel hoặc ID người dùng" aria-label="Tìm ticket"><select id="ticketFilter" aria-label="Lọc ticket"><option value="all">Tất cả trạng thái</option><option value="open">Đang mở</option><option value="ai">AI nhanh</option><option value="moderator">Moderator</option><option value="closed">Đã đóng</option></select></div>
                <div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Người tạo</th><th>Hỗ trợ</th><th>Trạng thái</th><th>Tạo lúc</th></tr></thead><tbody id="ticketRows"></tbody></table></div>
            </section>
            <section id="flowView" class="view">
                <section class="section"><div class="section-head"><div><h2>Luồng hỗ trợ ticket</h2><p>Quy trình thực tế từ lúc người dùng mở ticket đến khi lưu transcript.</p></div><span class="section-index">WORKFLOW</span></div>
                    <div class="flow-track">
                        <article class="flow-step"><b>01</b><strong>Chọn hỗ trợ</strong><p>Người dùng chọn Moderator hoặc AI nhanh từ panel Discord.</p></article>
                        <article class="flow-step"><b>02</b><strong>Thu thập yêu cầu</strong><p>Điền form bật lên hoặc trả lời câu hỏi trong channel.</p></article>
                        <article class="flow-step"><b>03</b><strong>Tạo channel riêng</strong><p>Bot tạo channel và cấp quyền theo đúng lựa chọn hỗ trợ.</p></article>
                        <article class="flow-step"><b>04</b><strong>Trao đổi xử lý</strong><p>Moderator nhận ticket hoặc bot AI được gọi vào ticket.</p></article>
                        <article class="flow-step"><b>05</b><strong>Lưu và xóa</strong><p>Khi đóng, transcript được lưu rồi channel ticket bị xóa.</p></article>
                    </div>
                    <div class="flow-note">Ticket AI chỉ dành cho người tạo và bot AI; ticket Moderator cho người tạo và moderator được nhận xử lý. Bot quản lý vẫn cần quyền channel để vận hành.</div>
                </section>
            </section>
            <section id="controlsView" class="view">
                <div id="notice" class="notice"></div>
                <div id="settingsError" class="notice error dashboard-error"></div>
                <div class="layout">
                    <div class="column">
                        <section class="section">
                            <div class="section-head"><div><h2>01 · Kênh & quyền</h2><p>Role moderator dùng cho ticket Moderator; ticket AI dùng bot AI đã cấu hình.</p></div><span class="section-index">SERVER</span></div>
                            <div class="fields">
                                <div class="field"><label for="panelChannelId">Kênh đăng panel</label><select id="panelChannelId"></select></div>
                                <div class="field"><label for="staffRoleId">Role moderator</label><select id="staffRoleId"></select></div>
                                <div class="field"><label for="categoryId">Category ticket</label><select id="categoryId"></select></div>
                                <div class="field"><label for="transcriptChannelId">Kênh lưu transcript</label><select id="transcriptChannelId"></select></div>
                            </div>
                        </section>
                        <section class="section">
                            <div class="section-head"><div><h2>02 · Giao diện panel</h2><p>Hai nút lựa chọn được cố định theo luồng hỗ trợ.</p></div><span class="section-index">PANEL</span></div>
                            <div class="fields">
                                <div class="field wide"><label for="serverName">Tên server</label><input id="serverName" maxlength="100"></div>
                                <div class="field"><label for="panelTitle">Tiêu đề panel</label><input id="panelTitle" maxlength="256"></div>
                                <div class="field"><label>Lựa chọn hỗ trợ</label><div><span class="discord-action">🛡️ Moderator</span> <span class="discord-action" style="background:#248046">🤖 AI nhanh</span></div></div>
                                <div class="field"><label for="aiBotId">Bot AI</label><input id="aiBotId" value="1554091816960135238" readonly><small>ID bot AI dùng cho ticket AI nhanh.</small></div>
                                <div class="field wide"><label for="panelDescription">Mô tả panel</label><textarea id="panelDescription" maxlength="4000"></textarea></div>
                                <div class="field"><label for="color">Màu chủ đạo</label><div class="color-row"><input id="colorPicker" type="color"><input id="color" type="text" maxlength="7" pattern="#[0-9a-fA-F]{6}"></div></div>
                            </div>
                        </section>
                        <section class="section">
                            <div class="section-head"><div><h2>03 · Tiếp nhận yêu cầu</h2><p>Câu trả lời sẽ xuất hiện trong ticket và transcript.</p></div><span class="section-index">FORM</span></div>
                            <div class="switch-line"><div><strong>Bật form trước khi tạo ticket</strong><small>Thu thập thông tin ban đầu từ người gửi.</small></div><input id="formEnabled" class="switch" type="checkbox"></div>
                            <div id="formControls" class="hidden">
                                <div class="field" style="margin:14px 0"><label>Chế độ form</label><div class="segmented"><button type="button" data-mode="modal" class="selected">Form bật lên</button><button type="button" data-mode="channel">Câu hỏi trong kênh</button></div></div>
                                <div class="field" style="margin-bottom:14px"><label for="formTitle">Tiêu đề form</label><input id="formTitle" maxlength="45"></div>
                                <div id="questions" class="questions"></div>
                                <button id="addQuestion" type="button" class="add-question">＋ Thêm câu hỏi</button>
                            </div>
                            <div id="formOff" class="help">Form đang tắt; người dùng sẽ vào thẳng ticket và mô tả yêu cầu.</div>
                        </section>
                        <section class="section">
                            <div class="section-head"><div><h2>04 · Nội dung ticket</h2><p>Embed đầu tiên trong channel riêng.</p></div><span class="section-index">TICKET</span></div>
                            <div class="fields">
                                <div class="field"><label for="ticketTitle">Tiêu đề</label><input id="ticketTitle" maxlength="256"></div>
                                <div class="field wide"><label for="ticketIntro">Lời nhắn hướng dẫn</label><textarea id="ticketIntro" maxlength="4000"></textarea></div>
                            </div>
                        </section>
                    </div>
                    <div class="column">
                        <section class="section preview-sticky">
                            <div class="preview-label"><span>Xem trước Discord</span><span>LIVE PREVIEW</span></div>
                            <div class="discord-card" id="panelPreview">
                                <div class="discord-server" id="previewServer"></div>
                                <h3 id="previewTitle"></h3>
                                <p id="previewDescription"></p>
                                <div><span class="discord-action">🛡️ Moderator</span> <span class="discord-action" style="background:#248046">🤖 AI nhanh</span></div>
                                <div class="preview-ticket"><b id="previewTicketTitle"></b><span id="previewTicketIntro"></span></div>
                            </div>
                            <p class="help" style="margin-top:12px">Preview cập nhật khi bạn chỉnh nội dung. Discord sẽ đổi panel sau khi lưu.</p>
                        </section>
                    </div>
                </div>
                <div class="actions"><button id="saveButton" class="button" type="button">Lưu cài đặt</button><button id="publishButton" class="button primary" type="button">Lưu & cập nhật panel</button></div>
            </section>
            <section id="logsView" class="view"><div class="dashboard-toolbar"><small id="logStatus">Nhật ký được giữ trong bộ nhớ của phiên chạy hiện tại.</small><button id="clearLogs" class="button" type="button">Xóa màn hình</button></div><div id="logs"></div></section>
        </main>
    </div>
    <script>
        const fields = ['serverName','panelTitle','panelDescription','color','ticketTitle','ticketIntro','formTitle'];
        const $ = id => document.getElementById(id);
        let password = '';
        let settings;
        let logController;
        let questionData = [];
        let activeMode = 'modal';
        let logCount = 0;
        let dashboardSnapshotData;
        let dashboardRefreshTimer;
        let dashboardLoading = false;

        async function request(path, method = 'GET', body) {
            const headers = { 'x-dashboard-password': password };
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            const response = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
            const text = await response.text();
            let data;
            try { data = text ? JSON.parse(text) : {}; }
            catch { throw new Error('Server trả về phản hồi không hợp lệ (HTTP ' + response.status + ').'); }
            if (!response.ok) throw new Error(data.error || 'Yêu cầu thất bại.');
            return data;
        }

        function renderActivityChart(days) {
            const container = $('activityChart');
            container.replaceChildren();
            const series = [
                { key: 'created', label: 'Tạo ticket', className: 'created' },
                { key: 'claimed', label: 'Moderator nhận', className: 'claimed' },
                { key: 'deleted', label: 'Xóa ticket', className: 'deleted' }
            ];
            const maximum = Math.max(1, ...days.flatMap(day => series.map(item => day[item.key])));

            for (const day of days) {
                const column = document.createElement('div');
                column.className = 'chart-day';
                const bars = document.createElement('div');
                bars.className = 'chart-bars';
                for (const item of series) {
                    const bar = document.createElement('i');
                    const value = day[item.key];
                    bar.className = 'activity-bar ' + item.className;
                    bar.style.height = Math.round(value / maximum * 100) + '%';
                    bar.title = item.label + ': ' + value;
                    bar.setAttribute('aria-label', item.label + ': ' + value);
                    bars.append(bar);
                }
                const label = document.createElement('label');
                label.textContent = day.date.slice(5);
                column.append(bars, label);
                container.append(column);
            }
        }

        function renderBreakdown(stats) {
            const container = $('modeBreakdown');
            container.replaceChildren();
            const maximum = Math.max(1, stats.open);
            for (const item of [
                { label: 'Moderator', value: stats.moderator, className: '' },
                { label: 'AI nhanh', value: stats.ai, className: 'ai' }
            ]) {
                const row = document.createElement('div');
                row.className = 'break-row';
                const label = document.createElement('span'); label.textContent = item.label;
                const track = document.createElement('div'); track.className = 'break-track';
                const fill = document.createElement('div'); fill.className = 'break-fill' + (item.className ? ' ' + item.className : '');
                fill.style.width = item.value / maximum * 100 + '%';
                track.append(fill);
                const count = document.createElement('strong'); count.className = 'break-count'; count.textContent = item.value;
                row.append(label, track, count); container.append(row);
            }
        }

        function renderRecentActivity(events) {
            const container = $('recentActivity');
            container.replaceChildren();
            const labels = { created: 'Tạo ticket', claimed: 'Moderator nhận ticket', deleted: 'Xóa ticket' };
            if (!events.length) {
                const empty = document.createElement('p'); empty.className = 'help';
                empty.textContent = 'Chưa có hoạt động ticket trong phiên bot này.';
                container.append(empty);
                return;
            }

            for (const event of events) {
                const row = document.createElement('div'); row.className = 'activity-item';
                const detail = document.createElement('div');
                const title = document.createElement('strong'); title.textContent = labels[event.action] || 'Hoạt động ticket';
                const subtitle = document.createElement('small');
                subtitle.textContent = (event.ticketName || event.ticketId) + ' · ' + (event.supportMode === 'ai' ? 'AI nhanh' : 'Moderator') + ' · ' + event.actorId;
                detail.append(title, subtitle);
                const time = document.createElement('small'); time.textContent = new Date(event.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                row.append(detail, time); container.append(row);
            }
        }

        function renderTickets() {
            const body = $('ticketRows');
            body.replaceChildren();
            if (!dashboardSnapshotData) return;
            const search = $('ticketSearch').value.trim().toLowerCase();
            const filter = $('ticketFilter').value;
            const tickets = dashboardSnapshotData.tickets.filter(ticket => {
                const matchesSearch = (ticket.name + ' ' + ticket.ownerId).toLowerCase().includes(search);
                const matchesFilter = filter === 'all' ||
                    (filter === 'open' && !ticket.closed) ||
                    (filter === 'closed' && ticket.closed) ||
                    (filter === 'ai' && ticket.supportMode === 'ai') ||
                    (filter === 'moderator' && ticket.supportMode === 'moderator');
                return matchesSearch && matchesFilter;
            });

            if (!tickets.length) {
                const row = document.createElement('tr');
                const cell = document.createElement('td'); cell.className = 'empty-row'; cell.colSpan = 5;
                cell.textContent = 'Không tìm thấy ticket phù hợp.';
                row.append(cell); body.append(row); return;
            }

            for (const ticket of tickets) {
                const row = document.createElement('tr');
                const channelCell = document.createElement('td');
                const link = document.createElement('a'); link.className = 'table-link'; link.href = ticket.url;
                link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '#' + ticket.name;
                channelCell.append(link);
                const ownerCell = document.createElement('td'); ownerCell.textContent = ticket.ownerId;
                const supportCell = document.createElement('td'); supportCell.textContent = ticket.supportMode === 'ai' ? 'AI nhanh' : 'Moderator';
                const statusCell = document.createElement('td');
                const status = document.createElement('span'); status.className = 'status-tag' + (ticket.closed ? ' closed' : ''); status.textContent = ticket.status;
                statusCell.append(status);
                const createdCell = document.createElement('td');
                createdCell.textContent = new Date(ticket.createdAt).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                row.append(channelCell, ownerCell, supportCell, statusCell, createdCell); body.append(row);
            }
        }

        async function loadDashboard() {
            if (dashboardLoading) return;
            dashboardLoading = true;
            const error = $('dashboardError');
            try {
                const status = await request('/api/status');
                $('statusDot').classList.toggle('live', status.ready && status.guildAvailable);
                $('statusText').textContent = !status.ready
                    ? 'Bot chưa kết nối Discord'
                    : !status.guildAvailable
                        ? 'Bot không thấy server ticket'
                        : 'Bot online · ping ' + status.ping + ' ms';
                dashboardSnapshotData = await request('/api/dashboard');
                const { stats } = dashboardSnapshotData;
                $('metricOpen').textContent = stats.open;
                $('metricWaiting').textContent = stats.waiting + ' chờ moderator';
                $('metricAI').textContent = stats.ai;
                $('metricModerator').textContent = stats.moderator;
                $('metricClaimed').textContent = stats.claimed + ' đã nhận xử lý';
                $('metricEvents').textContent = stats.events;
                const updated = new Date(dashboardSnapshotData.generatedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                $('dashboardUpdated').textContent = 'Cập nhật ' + updated + ' · hoạt động từ khi bot khởi động';
                $('ticketDataUpdated').textContent = dashboardSnapshotData.tickets.length + ' ticket channel · cập nhật ' + updated;
                renderActivityChart(dashboardSnapshotData.activity);
                renderBreakdown(stats);
                renderRecentActivity(dashboardSnapshotData.recentEvents);
                renderTickets();
                error.classList.remove('show');
            } catch (requestError) {
                error.textContent = requestError.message + ' Kiểm tra log và xác nhận bot đã vào đúng server, có quyền xem channel.';
                error.classList.add('show');
                if (!dashboardSnapshotData) {
                    $('metricOpen').textContent = '—';
                    $('metricAI').textContent = '—';
                    $('metricModerator').textContent = '—';
                    $('metricEvents').textContent = '—';
                }
            } finally {
                dashboardLoading = false;
            }
        }

        function notice(message, type = 'success') {
            const element = $('notice');
            element.textContent = message;
            element.className = 'notice show ' + type;
            clearTimeout(notice.timer);
            notice.timer = setTimeout(() => element.classList.remove('show'), 5000);
        }

        function setOptions(id, items, selected, emptyLabel) {
            const select = $(id);
            select.replaceChildren(new Option(emptyLabel, ''));
            for (const item of items) select.add(new Option(item.name, item.id));
            select.value = selected || '';
        }

        function renderQuestions() {
            const container = $('questions');
            container.replaceChildren();
            questionData.forEach((question, index) => {
                const row = document.createElement('div');
                row.className = 'question';
                const main = document.createElement('div');
                main.className = 'question-main';
                const label = document.createElement('input');
                label.type = 'text'; label.maxLength = 45; label.placeholder = 'Câu hỏi'; label.value = question.label;
                label.setAttribute('aria-label', 'Nội dung câu hỏi ' + (index + 1));
                label.addEventListener('input', () => { question.label = label.value; updatePreview(); });
                const placeholder = document.createElement('input');
                placeholder.type = 'text'; placeholder.maxLength = 100; placeholder.placeholder = 'Gợi ý khi trả lời'; placeholder.value = question.placeholder;
                placeholder.setAttribute('aria-label', 'Gợi ý câu trả lời ' + (index + 1));
                placeholder.addEventListener('input', () => { question.placeholder = placeholder.value; });
                const meta = document.createElement('div'); meta.className = 'question-meta';
                const requiredLabel = document.createElement('label');
                const required = document.createElement('input'); required.type = 'checkbox'; required.checked = question.required;
                required.addEventListener('change', () => { question.required = required.checked; });
                requiredLabel.append(required, document.createTextNode('Bắt buộc')); meta.append(requiredLabel);
                main.append(label, placeholder, meta);
                const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.textContent = '×'; remove.title = 'Xóa câu hỏi';
                remove.addEventListener('click', () => { questionData.splice(index, 1); renderQuestions(); });
                row.append(main, remove); container.append(row);
            });
            $('addQuestion').disabled = questionData.length >= 5;
        }

        function updatePreview() {
            $('previewServer').textContent = $('serverName').value;
            $('previewTitle').textContent = $('panelTitle').value;
            $('previewDescription').textContent = $('panelDescription').value;
            $('previewTicketTitle').textContent = $('ticketTitle').value;
            $('previewTicketIntro').textContent = $('ticketIntro').value;
            $('panelPreview').style.borderLeftColor = /^#[0-9a-fA-F]{6}$/.test($('color').value) ? $('color').value : '#2F8F83';
            $('formControls').classList.toggle('hidden', !$('formEnabled').checked);
            $('formOff').classList.toggle('hidden', $('formEnabled').checked);
        }

        function readSettings() {
            const result = { ...settings };
            for (const key of fields) result[key] = $(key).value;
            result.panelChannelId = $('panelChannelId').value;
            result.staffRoleId = $('staffRoleId').value;
            result.categoryId = $('categoryId').value;
            result.transcriptChannelId = $('transcriptChannelId').value;
            result.formEnabled = $('formEnabled').checked;
            result.formMode = activeMode;
            result.formQuestions = questionData.map(question => ({ ...question }));
            return result;
        }

        async function loadSettings() {
            const error = $('settingsError');
            try {
                const [saved, options] = await Promise.all([request('/api/ticket-settings'), request('/api/ticket-options')]);
                settings = saved;
                for (const key of fields) $(key).value = saved[key];
                setOptions('panelChannelId', options.channels, saved.panelChannelId, 'Chọn text channel');
                setOptions('transcriptChannelId', options.channels, saved.transcriptChannelId, 'Giữ transcript trong ticket');
                setOptions('categoryId', options.categories, saved.categoryId, 'Không dùng category');
                setOptions('staffRoleId', options.roles, saved.staffRoleId, 'Chọn moderator role');
                $('formEnabled').checked = saved.formEnabled;
                activeMode = saved.formMode;
                document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('selected', button.dataset.mode === activeMode));
                questionData = saved.formQuestions.map(question => ({ ...question }));
                $('guildId').textContent = saved.guildId;
                $('colorPicker').value = saved.color;
                renderQuestions(); updatePreview();
                error.classList.remove('show');
            } catch (loadError) {
                error.textContent = 'Không tải được cài đặt: ' + loadError.message + ' Hãy kiểm tra bot đã vào server ticket và có quyền xem channel/role.';
                error.classList.add('show');
                throw loadError;
            }
        }

        async function save(publish) {
            const button = publish ? $('publishButton') : $('saveButton');
            button.disabled = true;
            button.textContent = 'Đang lưu…';
            try {
                const payload = readSettings();
                settings = publish
                    ? await request('/api/ticket-panel', 'POST', payload)
                    : await request('/api/ticket-settings', 'POST', payload);
                notice(publish ? 'Đã lưu và cập nhật panel ticket trên Discord.' : 'Đã lưu cấu hình ticket. Panel Discord chưa thay đổi.');
                await loadSettings();
            } catch (error) { notice(error.message, 'error'); }
            finally { button.disabled = false; button.textContent = publish ? 'Lưu & cập nhật panel' : 'Lưu cài đặt'; }
        }

        $('authForm').addEventListener('submit', async event => {
            event.preventDefault();
            const errorBox = $('authError');
            const submitButton = $('authForm').querySelector('button[type="submit"]');
            submitButton.disabled = true;
            submitButton.textContent = 'Đang đăng nhập…';
            errorBox.className = 'notice error';
            try {
                const entered = $('password').value;
                const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: entered }) });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Không đăng nhập được.');
                password = entered;
                $('authScreen').classList.add('hidden'); $('app').classList.remove('hidden');
                $('statusDot').classList.remove('live'); $('statusText').textContent = 'Đang tải dữ liệu…';
                loadSettings().catch(() => {});
                loadDashboard();
                if (!dashboardRefreshTimer) dashboardRefreshTimer = setInterval(loadDashboard, 30000);
            } catch (error) {
                errorBox.textContent = error.message;
                errorBox.className = 'notice show error';
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Đăng nhập';
            }
        });

        $('addQuestion').addEventListener('click', () => {
            if (questionData.length >= 5) return;
            questionData.push({ label: '', placeholder: '', required: false }); renderQuestions();
        });
        $('formEnabled').addEventListener('change', updatePreview);
        document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
            activeMode = button.dataset.mode;
            document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('selected', item === button));
        }));
        fields.forEach(key => $(key).addEventListener('input', updatePreview));
        $('colorPicker').addEventListener('input', () => { $('color').value = $('colorPicker').value.toUpperCase(); updatePreview(); });
        $('color').addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test($('color').value)) $('colorPicker').value = $('color').value; updatePreview(); });
        $('saveButton').addEventListener('click', () => save(false));
        $('publishButton').addEventListener('click', () => save(true));
        $('refreshDashboard').addEventListener('click', loadDashboard);
        document.querySelectorAll('[data-refresh-dashboard]').forEach(button => button.addEventListener('click', loadDashboard));
        $('clearLogs').addEventListener('click', () => { $('logs').replaceChildren(); logCount = 0; });
        $('ticketSearch').addEventListener('input', renderTickets);
        $('ticketFilter').addEventListener('change', renderTickets);

        document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
            document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item === button));
            const view = button.dataset.view;
            const views = {
                analytics: ['Phân tích', 'Tình hình ticket và hoạt động của bot trong phiên hiện tại.'],
                data: ['Dữ liệu', 'Danh sách ticket channels và trạng thái hiện tại trên Discord.'],
                flow: ['Luồng', 'Các bước xử lý từ lúc mở ticket đến khi lưu transcript và xóa.'],
                controls: ['Điều khiển', 'Cấu hình hỗ trợ, form tiếp nhận và cập nhật panel Discord.'],
                logs: ['Nhật ký', 'Theo dõi hoạt động của bot theo thời gian thực.']
            };
            document.querySelectorAll('.view').forEach(section => section.classList.toggle('active', section.id === view + 'View'));
            $('pageTitle').textContent = views[view][0];
            $('pageSubtitle').textContent = views[view][1];
            if (view === 'analytics' || view === 'data') loadDashboard();
            const showLogs = view === 'logs';
            if (showLogs) connectLogs();
            else if (logController) {
                logController.abort();
                logController = null;
                $('logStatus').textContent = 'Nhật ký tạm dừng.';
            }
        }));

        function connectLogs() {
            if (logController) return;
            const controller = new AbortController();
            logController = controller;
            readLogs(controller.signal).finally(() => {
                if (logController === controller) logController = null;
            });
        }

        function appendLog(log) {
            const row = document.createElement('div'); row.className = 'log';
            const time = document.createElement('span'); time.className = 'time';
            time.textContent = '[' + new Date(log.time).toLocaleString('vi-VN') + '] ';
            const type = document.createElement('span'); type.className = String(log.type).toLowerCase();
            type.textContent = '[' + log.type + '] ';
            row.append(time, type, document.createTextNode(log.message));
            $('logs').append(row);
            if (++logCount > 1000) { $('logs').firstElementChild?.remove(); logCount--; }
        }

        async function readLogs(signal) {
            const wait = milliseconds => new Promise(resolve => {
                const timer = setTimeout(resolve, milliseconds);
                signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
            });
            while (!signal.aborted) {
                try {
                    const response = await fetch('/logs', { headers: { 'x-dashboard-password': password }, signal });
                    if (!response.ok) {
                        const text = await response.text();
                        let message = text;
                        try { message = JSON.parse(text).error || text; } catch {}
                        throw new Error(message || 'HTTP ' + response.status);
                    }
                    if (!response.body) throw new Error('Trình duyệt không hỗ trợ đọc nhật ký trực tiếp.');
                    $('logStatus').textContent = 'Đang nhận nhật ký trực tiếp · tối đa 1.000 dòng trên màn hình.';
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    while (!signal.aborted) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const messages = buffer.split('\\n\\n');
                        buffer = messages.pop();
                        for (const message of messages) {
                            const data = message.split('\\n').find(line => line.startsWith('data: '));
                            if (data) appendLog(JSON.parse(data.slice(6)));
                        }
                    }
                } catch (error) {
                    if (signal.aborted) break;
                    $('logStatus').textContent = 'Mất kết nối nhật ký (' + error.message + '); đang thử lại…';
                }
                if (!signal.aborted) await wait(3000);
            }
        }
    </script>
</body>
</html>
    `;
}

export function startLogServer(port, client) {
    const server = createDashboardServer(client);

    server.listen(port, '0.0.0.0', () => {
        console.log(`HTTP server đang chạy trên cổng ${port}`);
    });


    return server;
}
