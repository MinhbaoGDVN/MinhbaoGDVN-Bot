import 'dotenv/config';

import {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ButtonBuilder,
    StringSelectMenuBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    ActivityType,
    MessageFlags
} from 'discord.js';

import { startLogServer } from './src/web/log-server.js';
import { createTicketCommand, handleTicketInteraction } from './src/ticket/ticket-handler.js';
import { loadTicketSettings } from './src/ticket/ticket-settings.js';

const discordToken = process.env.DISCORD_TOKEN?.trim();
if (!discordToken) {
    throw new Error('Thiếu DISCORD_TOKEN. Hãy cấu hình biến môi trường này trên Render hoặc trong file .env.');
}

if (!process.env.DASHBOARD_PASSWORD?.trim()) {
    throw new Error('Thiếu DASHBOARD_PASSWORD. Hãy cấu hình biến môi trường này trên Render hoặc trong file .env.');
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});
client.loginState = 'connecting';
client.loginError = null;

process.on('warning', warning => {
    console.warn('[Node warning]', warning.stack || warning.message);
});

process.on('uncaughtExceptionMonitor', (error, origin) => {
    console.error(`[Node ${origin}]`, error);
});

client.on('error', error => {
    console.error('[Discord client error]', error);
});

client.on('warn', warning => {
    console.warn('[Discord warning]', warning);
});

client.on('shardError', (error, shardId) => {
    client.loginState = 'failed';
    client.loginError = error.message || String(error);
    console.error(`[Discord shard ${shardId} error]`, error);
});

client.on('shardDisconnect', (closeEvent, shardId) => {
    client.loginState = 'connecting';
    client.loginError = `Discord Gateway ngắt kết nối (code ${closeEvent.code}${closeEvent.reason ? `: ${closeEvent.reason}` : ''})`;
    console.warn(`[Discord shard ${shardId} disconnected] code=${closeEvent.code} reason=${closeEvent.reason || 'none'}`);
});

client.on('shardReconnecting', shardId => {
    client.loginState = 'connecting';
    console.warn(`[Discord shard ${shardId}] reconnecting`);
});

client.on('shardReady', shardId => {
    client.loginState = 'ready';
    client.loginError = null;
    console.log(`[Discord shard ${shardId}] ready`);
});

let lastBotMessageId = null;

const embedSessions = new Map();

const EMBED_SESSION_TIMEOUT = 15 * 60 * 1000;
const EMBED_MAX_FIELDS = 25;

function isUnknownInteractionError(error) {
    return error?.code === 10062 || error?.rawError?.code === 10062;
}

client.once('clientReady', async () => {
    client.loginState = 'ready';
    client.loginError = null;
    console.log(`Đã đăng nhập thành công với tên: ${client.user.tag}`);
    console.log(`Bot đã Online`)
    client.user.setPresence({
        activities: [{
            name: 'MinhbaoGDVN Custom Bot',
            type: ActivityType.Watching
        }],
        status: 'online'
    });
    const commands = [
        new SlashCommandBuilder()
            .setName('chat')
            .setDescription('Mở bảng nhập nội dung hỗ trợ Markdown'),

        new SlashCommandBuilder()
            .setName('delete')
            .setDescription('Xóa tin nhắn vừa nãy bot nói'),

        new SlashCommandBuilder()
            .setName('tag')
            .setDescription('Tag một người dùng hoặc role')
            .addMentionableOption(option =>
                option
                    .setName('target')
                    .setDescription('Người dùng hoặc role cần tag')
                    .setRequired(false)
            )
            .addStringOption(option =>
                option
                    .setName('special')
                    .setDescription('@everyone hoặc @here')
                    .setRequired(false)
                    .addChoices(
                        { name: '@everyone', value: 'everyone' },
                        { name: '@here', value: 'here' }
                    )
            ),

        new SlashCommandBuilder()
            .setName("embed")
            .setDescription("Tạo Discord Embed"),

        createTicketCommand()
    ];

    const rest = new REST({ version: '10' }).setToken(discordToken);
    try {
        console.log('Đang đăng ký lệnh...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Đăng ký lệnh thành công');
    } catch (error) {
        console.error(error);
    }
});

function createEmbedData() {
    return {
        title: "",
        description: "",
        url: "",
        color: "",
        timestamp: false,

        author: {
            name: "",
            url: "",
            iconURL: ""
        },

        footer: {
            text: "",
            iconURL: ""
        },

        thumbnail: "",
        image: "",

        fields: [],

        channelId: null
    };
}

function createEmbedSession(userId) {
    const old = embedSessions.get(userId);

    if (old?.timeout) {
        clearTimeout(old.timeout);
    }

    const data = createEmbedData();

    const timeout = setTimeout(() => {
        embedSessions.delete(userId);
    }, EMBED_SESSION_TIMEOUT);

    const session = {
        data,
        timeout,
        selectedField: null
    };

    embedSessions.set(userId, session);

    return session;
}

function deleteEmbedSession(userId) {
    const session = embedSessions.get(userId);

    if (session?.timeout) {
        clearTimeout(session.timeout);
    }

    embedSessions.delete(userId);
}

function validEmbedURL(value) {
    if (!value) return true;

    try {
        const url = new URL(value);

        return (
            url.protocol === "http:" ||
            url.protocol === "https:"
        );
    } catch {
        return false;
    }
}

function normalizeEmbedColor(value) {
    if (!value) return null;

    let color = value.trim();

    if (!color.startsWith("#")) {
        color = `#${color}`;
    }

    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        return null;
    }

    return color;
}

function buildDiscordEmbed(data) {
    const embed = new EmbedBuilder();

    if (data.title) {
        embed.setTitle(data.title);
    }

    if (data.description) {
        embed.setDescription(data.description);
    }

    if (data.url) {
        embed.setURL(data.url);
    }

    if (data.color) {
        const color = normalizeEmbedColor(data.color);

        if (color) {
            embed.setColor(color);
        }
    }

    if (data.timestamp) {
        embed.setTimestamp();
    }

    if (data.author.name) {
        const author = {
            name: data.author.name
        };

        if (data.author.url) {
            author.url = data.author.url;
        }

        if (data.author.iconURL) {
            author.icon_url = data.author.iconURL;
        }

        embed.setAuthor(author);
    }

    if (data.footer.text) {
        const footer = {
            text: data.footer.text
        };

        if (data.footer.iconURL) {
            footer.icon_url = data.footer.iconURL;
        }

        embed.setFooter(footer);
    }

    if (data.thumbnail) {
        embed.setThumbnail(data.thumbnail);
    }

    if (data.image) {
        embed.setImage(data.image);
    }

    if (data.fields.length) {
        embed.addFields(
            data.fields.map(field => ({
                name: field.name,
                value: field.value,
                inline: field.inline
            }))
        );
    }

    return embed;
}

function embedMainPanel(data) {
    return new EmbedBuilder()
        .setTitle("Embed Builder")
        .setDescription([
            `Title: ${data.title ? "Đã đặt" : "Chưa đặt"}`,
            `Description: ${data.description ? "Đã đặt" : "Chưa đặt"}`,
            `URL: ${data.url ? "Đã đặt" : "Chưa đặt"}`,
            `Color: ${data.color || "Mặc định"}`,
            `Author: ${data.author.name || "Chưa đặt"}`,
            `Footer: ${data.footer.text || "Chưa đặt"}`,
            `Image: ${data.image ? "Đã đặt" : "Chưa đặt"}`,
            `Thumbnail: ${data.thumbnail ? "Đã đặt" : "Chưa đặt"}`,
            `Fields: ${data.fields.length}/${EMBED_MAX_FIELDS}`,
            `Timestamp: ${data.timestamp ? "Bật" : "Tắt"}`,
            `Channel: ${data.channelId ? `<#${data.channelId}>` : "Chưa chọn"}`,
            "",
            "Chọn mục bên dưới để chỉnh sửa."
        ].join("\n"))
        .setColor(data.color || "#5865F2");
}

function embedMainMenu() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId("embed_menu")
            .setPlaceholder("Chọn phần Embed muốn chỉnh...")
            .addOptions(
                {
                    label: "Nội dung",
                    description: "Title, Description, URL, Color, Timestamp",
                    value: "content"
                },
                {
                    label: "Author",
                    description: "Tên, URL và Icon",
                    value: "author"
                },
                {
                    label: "Footer",
                    description: "Footer text và icon",
                    value: "footer"
                },
                {
                    label: "Media",
                    description: "Thumbnail và Image",
                    value: "media"
                },
                {
                    label: "Fields",
                    description: "Thêm, sửa và xóa Fields",
                    value: "fields"
                },
                {
                    label: "Preview",
                    description: "Xem Embed hiện tại",
                    value: "preview"
                }
            )
    );
}

function embedMainButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("embed_preview")
            .setLabel("Preview")
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId("embed_channel")
            .setLabel("Chọn Channel")
            .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
            .setCustomId("embed_send")
            .setLabel("Gửi Embed")
            .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
            .setCustomId("embed_cancel")
            .setLabel("Hủy")
            .setStyle(ButtonStyle.Danger)
    );
}

function embedContentModal(data) {
    return new ModalBuilder()
        .setCustomId("embed_modal_content")
        .setTitle("Embed - Nội dung")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("title")
                    .setLabel("Title")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(256)
                    .setValue(data.title || "")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("description")
                    .setLabel("Description")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(4000)
                    .setValue(data.description || "")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("url")
                    .setLabel("URL")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(data.url || "")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("color")
                    .setLabel("Color HEX")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setPlaceholder("#5865F2")
                    .setValue(data.color || "")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("timestamp")
                    .setLabel("Timestamp")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setPlaceholder("true hoặc false")
                    .setValue(data.timestamp ? "true" : "false")
            )
        );
}

function embedAuthorModal(data) {
    return new ModalBuilder()
        .setCustomId("embed_modal_author")
        .setTitle("Embed - Author")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("name")
                    .setLabel("Author Name")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(256)
                    .setValue(data.author.name || "")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("url")
                    .setLabel("Author URL")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(data.author.url || "")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("icon")
                    .setLabel("Author Icon URL")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(data.author.iconURL || "")
            )
        );
}

function embedFooterModal(data) {
    return new ModalBuilder()
        .setCustomId("embed_modal_footer")
        .setTitle("Embed - Footer")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("text")
                    .setLabel("Footer Text")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(2048)
                    .setValue(data.footer.text || "")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("icon")
                    .setLabel("Footer Icon URL")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(data.footer.iconURL || "")
            )
        );
}

function embedMediaModal(data) {
    return new ModalBuilder()
        .setCustomId("embed_modal_media")
        .setTitle("Embed - Media")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("thumbnail")
                    .setLabel("Thumbnail URL")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(data.thumbnail || "")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("image")
                    .setLabel("Image URL")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(data.image || "")
            )
        );
}

function embedFieldAddModal() {
    return new ModalBuilder()
        .setCustomId("embed_modal_field_add")
        .setTitle("Thêm Field")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("name")
                    .setLabel("Field Name")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(256)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("value")
                    .setLabel("Field Value")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1024)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("inline")
                    .setLabel("Inline?")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue("false")
            )
        );
}

function embedFieldEditModal(field, index) {
    return new ModalBuilder()
        .setCustomId(`embed_modal_field_edit_${index}`)
        .setTitle(`Sửa Field #${index + 1}`)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("name")
                    .setLabel("Field Name")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(256)
                    .setValue(field.name)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("value")
                    .setLabel("Field Value")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1024)
                    .setValue(field.value)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("inline")
                    .setLabel("Inline?")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(field.inline ? "true" : "false")
            )
        );
}

function embedFieldsPanel(session) {
    const data = session.data;

    const embed = new EmbedBuilder()
        .setTitle("Embed Builder - Fields")
        .setDescription(
            data.fields.length
                ? data.fields.map((field, index) =>
                    `**${index + 1}. ${field.name}**\n${field.value}\nInline: ${field.inline ? "Yes" : "No"}`
                ).join("\n\n")
                : "Chưa có Field nào."
        )
        .setColor(data.color || "#5865F2");

    const components = [];

    if (data.fields.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId("embed_field_select")
            .setPlaceholder("Chọn Field...");

        data.fields.forEach((field, index) => {
            select.addOptions({
                label: `${index + 1}. ${field.name}`.slice(0, 100),
                description: field.value.slice(0, 100),
                value: String(index)
            });
        });

        components.push(
            new ActionRowBuilder().addComponents(select)
        );
    }

    components.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("embed_field_add")
                .setLabel("Thêm Field")
                .setStyle(ButtonStyle.Success)
                .setDisabled(data.fields.length >= EMBED_MAX_FIELDS),

            new ButtonBuilder()
                .setCustomId("embed_field_edit")
                .setLabel("Sửa Field")
                .setStyle(ButtonStyle.Primary)
                .setDisabled(data.fields.length === 0),

            new ButtonBuilder()
                .setCustomId("embed_field_delete")
                .setLabel("Xóa Field")
                .setStyle(ButtonStyle.Danger)
                .setDisabled(data.fields.length === 0),

            new ButtonBuilder()
                .setCustomId("embed_back")
                .setLabel("Quay lại")
                .setStyle(ButtonStyle.Secondary)
        )
    );

    return {
        embed,
        components
    };
}

function embedChannelSelector() {
    return new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId("embed_channel_select")
            .setPlaceholder("Chọn channel để gửi Embed...")
            .setChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement
            )
    );
}

async function handleEmbedInteraction(interaction) {
    const session = embedSessions.get(interaction.user.id);

    if (!session) {
        await interaction.reply({
            content: "Embed Builder đã hết hạn. Hãy chạy `/embed` lại.",
            ephemeral: true
        });

        return true;
    }

    const data = session.data;

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === "embed_menu") {
            const value = interaction.values[0];

            if (value === "content") {
                await interaction.showModal(
                    embedContentModal(data)
                );
                return true;
            }

            if (value === "author") {
                await interaction.showModal(
                    embedAuthorModal(data)
                );
                return true;
            }

            if (value === "footer") {
                await interaction.showModal(
                    embedFooterModal(data)
                );
                return true;
            }

            if (value === "media") {
                await interaction.showModal(
                    embedMediaModal(data)
                );
                return true;
            }

            if (value === "fields") {
                const panel = embedFieldsPanel(session);

                await interaction.update({
                    embeds: [panel.embed],
                    components: panel.components
                });

                return true;
            }

            if (value === "preview") {
                await interaction.update({
                    embeds: [
                        embedMainPanel(data),
                        buildDiscordEmbed(data)
                    ],
                    components: [
                        embedMainMenu(),
                        embedMainButtons()
                    ]
                });

                return true;
            }
        }

        if (interaction.customId === "embed_field_select") {
            session.selectedField =
                Number(interaction.values[0]);

            await interaction.deferUpdate();

            return true;
        }
    }

    if (interaction.isChannelSelectMenu()) {
        if (interaction.customId === "embed_channel_select") {
            const channelId = interaction.values[0];

            const channel =
                interaction.guild.channels.cache.get(channelId);

            if (!channel || !channel.isTextBased()) {
                await interaction.reply({
                    content: "Channel không hợp lệ.",
                    ephemeral: true
                });

                return true;
            }

            data.channelId = channelId;

            await interaction.update({
                embeds: [embedMainPanel(data)],
                components: [
                    embedMainMenu(),
                    embedMainButtons()
                ]
            });

            return true;
        }
    }

    if (interaction.isButton()) {
        if (interaction.customId === "embed_preview") {
            await interaction.update({
                embeds: [
                    embedMainPanel(data),
                    buildDiscordEmbed(data)
                ],
                components: [
                    embedMainMenu(),
                    embedMainButtons()
                ]
            });

            return true;
        }

        if (interaction.customId === "embed_back") {
            await interaction.update({
                embeds: [embedMainPanel(data)],
                components: [
                    embedMainMenu(),
                    embedMainButtons()
                ]
            });

            return true;
        }

        if (interaction.customId === "embed_cancel") {
            deleteEmbedSession(interaction.user.id);

            await interaction.update({
                content: "Embed Builder đã được hủy.",
                embeds: [],
                components: []
            });

            return true;
        }

        if (interaction.customId === "embed_channel") {
            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("Chọn Channel")
                        .setDescription(
                            "Chọn channel mà bot sẽ gửi Embed."
                        )
                        .setColor("#5865F2")
                ],
                components: [
                    embedChannelSelector(),
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("embed_back")
                            .setLabel("Quay lại")
                            .setStyle(ButtonStyle.Secondary)
                    )
                ]
            });

            return true;
        }

        if (interaction.customId === "embed_send") {
            if (!data.channelId) {
                await interaction.reply({
                    content: "Bạn chưa chọn channel.",
                    ephemeral: true
                });

                return true;
            }

            const channel =
                interaction.guild.channels.cache.get(
                    data.channelId
                );

            if (!channel || !channel.isTextBased()) {
                await interaction.reply({
                    content: "Channel không hợp lệ.",
                    ephemeral: true
                });

                return true;
            }

            const me = interaction.guild.members.me;

            if (
                me &&
                !channel.permissionsFor(me)?.has("SendMessages")
            ) {
                await interaction.reply({
                    content:
                        "Bot không có quyền `Send Messages` trong channel này.",
                    ephemeral: true
                });

                return true;
            }

            await interaction.deferUpdate();
            try {
                await channel.send({
                    embeds: [buildDiscordEmbed(data)]
                });
            } catch (error) {
                console.error("Lỗi khi gửi Embed:", error);
                await interaction.editReply({
                    content: "Không gửi được Embed. Hãy kiểm tra quyền của bot trong channel.",
                    embeds: [],
                    components: []
                });
                deleteEmbedSession(interaction.user.id);
                return true;
            }

            deleteEmbedSession(interaction.user.id);

            await interaction.editReply({
                content:
                    `Đã gửi Embed thành công vào ${channel}.`,
                embeds: [],
                components: []
            });

            return true;
        }

        if (interaction.customId === "embed_field_add") {
            if (data.fields.length >= EMBED_MAX_FIELDS) {
                await interaction.reply({
                    content: "Embed chỉ được tối đa 25 Fields.",
                    ephemeral: true
                });

                return true;
            }

            await interaction.showModal(
                embedFieldAddModal()
            );

            return true;
        }

        if (interaction.customId === "embed_field_edit") {
            const index = session.selectedField;

            if (
                index === null ||
                index === undefined ||
                !data.fields[index]
            ) {
                await interaction.reply({
                    content: "Hãy chọn một Field trước.",
                    ephemeral: true
                });

                return true;
            }

            await interaction.showModal(
                embedFieldEditModal(
                    data.fields[index],
                    index
                )
            );

            return true;
        }

        if (interaction.customId === "embed_field_delete") {
            const index = session.selectedField;

            if (
                index === null ||
                index === undefined ||
                !data.fields[index]
            ) {
                await interaction.reply({
                    content: "Hãy chọn một Field trước.",
                    ephemeral: true
                });

                return true;
            }

            data.fields.splice(index, 1);
            session.selectedField = null;

            const panel = embedFieldsPanel(session);

            await interaction.update({
                embeds: [panel.embed],
                components: panel.components
            });

            return true;
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === "embed_modal_content") {
            const title =
                interaction.fields.getTextInputValue("title");

            const description =
                interaction.fields.getTextInputValue("description");

            const url =
                interaction.fields.getTextInputValue("url");

            const color =
                interaction.fields.getTextInputValue("color");

            const timestamp =
                interaction.fields.getTextInputValue("timestamp");

            if (!validEmbedURL(url)) {
                await interaction.reply({
                    content: "URL không hợp lệ.",
                    ephemeral: true
                });

                return true;
            }

            const normalizedColor =
                normalizeEmbedColor(color);

            if (color && !normalizedColor) {
                await interaction.reply({
                    content:
                        "Color phải là HEX, ví dụ `#5865F2`.",
                    ephemeral: true
                });

                return true;
            }

            data.title = title.trim();
            data.description = description;
            data.url = url.trim();
            data.color = normalizedColor || "";
            data.timestamp =
                timestamp.trim().toLowerCase() === "true";

            await interaction.reply({
                content: "Đã cập nhật nội dung.",
                embeds: [embedMainPanel(data)],
                components: [
                    embedMainMenu(),
                    embedMainButtons()
                ],
                ephemeral: true
            });

            return true;
        }

        if (interaction.customId === "embed_modal_author") {
            const name =
                interaction.fields.getTextInputValue("name");

            const url =
                interaction.fields.getTextInputValue("url");

            const icon =
                interaction.fields.getTextInputValue("icon");

            if (
                !validEmbedURL(url) ||
                !validEmbedURL(icon)
            ) {
                await interaction.reply({
                    content:
                        "Author URL hoặc Icon URL không hợp lệ.",
                    ephemeral: true
                });

                return true;
            }

            data.author = {
                name: name.trim(),
                url: url.trim(),
                iconURL: icon.trim()
            };

            await interaction.reply({
                content: "Đã cập nhật Author.",
                embeds: [embedMainPanel(data)],
                components: [
                    embedMainMenu(),
                    embedMainButtons()
                ],
                ephemeral: true
            });

            return true;
        }

        if (interaction.customId === "embed_modal_footer") {
            const text =
                interaction.fields.getTextInputValue("text");

            const icon =
                interaction.fields.getTextInputValue("icon");

            if (!validEmbedURL(icon)) {
                await interaction.reply({
                    content:
                        "Footer Icon URL không hợp lệ.",
                    ephemeral: true
                });

                return true;
            }

            data.footer = {
                text: text.trim(),
                iconURL: icon.trim()
            };

            await interaction.reply({
                content: "Đã cập nhật Footer.",
                embeds: [embedMainPanel(data)],
                components: [
                    embedMainMenu(),
                    embedMainButtons()
                ],
                ephemeral: true
            });

            return true;
        }

        if (interaction.customId === "embed_modal_media") {
            const thumbnail =
                interaction.fields.getTextInputValue("thumbnail");

            const image =
                interaction.fields.getTextInputValue("image");

            if (
                !validEmbedURL(thumbnail) ||
                !validEmbedURL(image)
            ) {
                await interaction.reply({
                    content:
                        "Thumbnail URL hoặc Image URL không hợp lệ.",
                    ephemeral: true
                });

                return true;
            }

            data.thumbnail = thumbnail.trim();
            data.image = image.trim();

            await interaction.reply({
                content: "Đã cập nhật Media.",
                embeds: [embedMainPanel(data)],
                components: [
                    embedMainMenu(),
                    embedMainButtons()
                ],
                ephemeral: true
            });

            return true;
        }

        if (interaction.customId === "embed_modal_field_add") {
            if (data.fields.length >= EMBED_MAX_FIELDS) {
                await interaction.reply({
                    content: "Embed chỉ được tối đa 25 Fields.",
                    ephemeral: true
                });

                return true;
            }

            const name =
                interaction.fields.getTextInputValue("name");

            const value =
                interaction.fields.getTextInputValue("value");

            const inline =
                interaction.fields.getTextInputValue("inline");

            data.fields.push({
                name,
                value,
                inline:
                    inline.trim().toLowerCase() === "true"
            });

            const panel = embedFieldsPanel(session);

            await interaction.reply({
                content: "Đã thêm Field.",
                embeds: [panel.embed],
                components: panel.components,
                ephemeral: true
            });

            return true;
        }

        if (
            interaction.customId.startsWith(
                "embed_modal_field_edit_"
            )
        ) {
            const index = Number(
                interaction.customId.replace(
                    "embed_modal_field_edit_",
                    ""
                )
            );

            if (!data.fields[index]) {
                await interaction.reply({
                    content: "Field không tồn tại.",
                    ephemeral: true
                });

                return true;
            }

            const name =
                interaction.fields.getTextInputValue("name");

            const value =
                interaction.fields.getTextInputValue("value");

            const inline =
                interaction.fields.getTextInputValue("inline");

            data.fields[index] = {
                name,
                value,
                inline:
                    inline.trim().toLowerCase() === "true"
            };

            const panel = embedFieldsPanel(session);

            await interaction.reply({
                content: "Đã cập nhật Field.",
                embeds: [panel.embed],
                components: panel.components,
                ephemeral: true
            });

            return true;
        }
    }

    return false;
}

client.on('interactionCreate', async interaction => {
    const action = interaction.isChatInputCommand()
        ? `/${interaction.commandName}`
        : interaction.customId || `type ${interaction.type}`;
    console.log(`[Discord interaction] ${action} by ${interaction.user?.tag || interaction.user?.id || 'unknown'} (${interaction.user?.id || 'unknown'}) in ${interaction.guildId || 'DM'}`);

    try {
        if (await handleTicketInteraction(interaction, client)) return;

        if (
            interaction.isChatInputCommand() &&
            interaction.commandName === "embed"
        ) {
            const existing = embedSessions.get(interaction.user.id);

            if (existing) {
                return interaction.reply({
                    content: "Bạn đang có một Embed Builder đang mở.",
                    ephemeral: true
                });
            }

            const session = createEmbedSession(interaction.user.id);
            return interaction.reply({
                embeds: [embedMainPanel(session.data)],
                components: [
                    embedMainMenu(),
                    embedMainButtons()
                ],
                ephemeral: true
            });
        }

        if (
            interaction.customId?.startsWith("embed_") &&
            !interaction.isChatInputCommand()
        ) {
            return handleEmbedInteraction(interaction);
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'chatModal') {
                const textMessage = interaction.fields.getTextInputValue('userInput');

                try {
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const sentMessage = await interaction.channel.send({ content: textMessage });

                    lastBotMessageId = sentMessage.id;
                    console.log(`Đã hoàn thành lệnh /chat`);
                    await interaction.editReply({ content: 'Đã gửi nội dung ra kênh thành công!' });
                } catch (error) {
                    console.error('Lỗi khi gửi tin nhắn:', error);
                    if (isUnknownInteractionError(error)) {
                        console.warn(`Interaction ${interaction.id} expired while sending a message.`);
                        return;
                    }

                    if (interaction.deferred) {
                        await interaction.editReply({ content: 'Đã có lỗi xảy ra khi gửi tin nhắn!' });
                    } else if (!interaction.replied) {
                        await interaction.reply({
                            content: 'Đã có lỗi xảy ra khi gửi tin nhắn!',
                            flags: MessageFlags.Ephemeral
                        });
                    }
                }
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'tag') {
            console.log(`Đẵ bắt đầu lệnh /tag`)
            const userId = interaction.user.id;
            const correctID = ["1422193218006679745"];

            if (!correctID.includes(userId)) {
                console.log(`Có người sử dụng lệnh và không có quyền, ID cửa người đó: ${userId}`);

                await interaction.reply({
                    content: "Bạn không có quyền sử dụng bot.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }
            console.log(`Dã qua xác minh`)

            const target = interaction.options.getMentionable('target');
            const special = interaction.options.getString('special');

            let mention;

            if (special === 'everyone') {
                mention = '@everyone';
            } else if (special === 'here') {
                mention = '@here';
            } else if (target) {
                mention = `<@${target.id}>`;
            } else {
                return await interaction.reply({
                    content: 'Bạn phải chọn User, Role, @everyone hoặc @here.',
                    flags: MessageFlags.Ephemeral
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.channel.send({
                content: mention,
                allowedMentions: {
                    parse: ['users', 'roles', 'everyone']
                }
            });

            await interaction.editReply({
                content: 'Đã tag.'
            });
        }

        if (interaction.commandName === 'chat') {
            console.log(`Đẵ bắt đầu lệnh /chat`)
            const userId = interaction.user.id;
            const correctID = ["1422193218006679745"];

            if (!correctID.includes(userId)) {
                console.log(`Có người sử dụng lệnh và không có quyền, ID cửa người đó: ${userId}`);

                await interaction.reply({
                    content: "Bạn không có quyền sử dụng bot.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }
            console.log(`Dã qua xác minh`)
            const modal = new ModalBuilder()
                .setCustomId('chatModal')
                .setTitle('MinhbaoGDVN Chat Form');
            const userInput = new TextInputBuilder()
                .setCustomId('userInput')
                .setLabel('Nhập nội dung của bạn (hỗ trợ Markdown):')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(userInput));
            await interaction.showModal(modal);
        }

        if (interaction.commandName === 'delete') {
            console.log(`Đẵ bắt đầu lệnh /delete`)
            const userId = interaction.user.id;
            const correctID = ["1422193218006679745"];

            if (!correctID.includes(userId)) {
                console.log(`Có người sử dụng lệnh và không có quyền, ID cửa người đó: ${userId}`);

                await interaction.reply({
                    content: "Bạn không có quyền sử dụng bot.",
                    flags: MessageFlags.Ephemeral
                });

                return;
            }
            console.log(`Dã qua xác minh`)
            if (!lastBotMessageId) {
                await interaction.reply({
                    content: 'Không có tin nhắn nào gần đây để xóa!',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            try {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const messageToDelete = await interaction.channel.messages.fetch(lastBotMessageId);
                await messageToDelete.delete();
                console.log(`Đẵ hoàn thành lệnh /delete`)
                await interaction.editReply({
                    content: 'Đã xóa tin nhắn vừa nãy!'
                });
                lastBotMessageId = null;
            } catch (error) {
                console.error('Lỗi khi xóa tin nhắn:', error);
                if (isUnknownInteractionError(error)) {
                    console.warn(`Interaction ${interaction.id} expired while deleting a message.`);
                    return;
                }

                if (interaction.deferred) {
                    await interaction.editReply({ content: 'Không thể xóa tin nhắn.' });
                } else if (!interaction.replied) {
                    await interaction.reply({
                        content: 'Không thể xóa tin nhắn.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            }
        }

    } catch (error) {
        if (isUnknownInteractionError(error)) {
            const action = interaction.customId || interaction.commandName || `type ${interaction.type}`;
            console.warn(`Interaction ${interaction.id} (${action}) expired before it could be acknowledged.`);
            return;
        }

        console.error("Lỗi xử lý interaction:", error);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: "Đã xảy ra lỗi khi xử lý thao tác này.",
                flags: MessageFlags.Ephemeral
            }).catch(replyError => {
                if (isUnknownInteractionError(replyError)) {
                    console.warn(`Interaction ${interaction.id} expired before the error response.`);
                    return;
                }
                console.error("Lỗi gửi phản hồi lỗi:", replyError);
            });
        }
    }

});

const PORT = process.env.PORT || 8070;

const webServer = startLogServer(PORT, client);
console.log('[Startup] HTTP server đã mở; đang tải cấu hình ticket.');
await loadTicketSettings();
console.log(`[Startup] Đã tải cấu hình ticket; bắt đầu đăng nhập Discord Gateway (Node ${process.version}, HTTP port ${PORT}).`);

const loginWatchdog = setTimeout(() => {
    if (client.isReady()) return;
    client.loginState = 'connecting';
    client.loginError = 'Chưa nhận được tín hiệu Discord Gateway sau 30 giây; đang tiếp tục thử kết nối.';
    console.error(`[Startup] Discord Gateway chưa sẵn sàng sau 30 giây. Kiểm tra token và các sự kiện shard tiếp theo.`);
}, 30_000);
loginWatchdog.unref();

try {
    await client.login(discordToken);
} catch (error) {
    clearTimeout(loginWatchdog);
    client.loginState = 'failed';
    client.loginError = error.message || String(error);
    console.error('[Startup] Đăng nhập Discord thất bại. Kiểm tra DISCORD_TOKEN trong Environment của Render:', error);
}
