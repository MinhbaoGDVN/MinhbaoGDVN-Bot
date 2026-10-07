import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import {
    DEFAULT_TICKET_SETTINGS,
    TICKET_GUILD_ID,
    loadTicketSettings,
    saveTicketSettings,
    validateTicketSettings
} from './ticket-settings.js';
import { recordTicketActivity } from './ticket-activity.js';

export { TICKET_GUILD_ID };

const ticketCreations = new Set();
const ticketClaims = new Set();
const AI_BOT_ID = '1554091816960135238';

function ticketColor(settings) {
    return Number.parseInt(settings.color.slice(1), 16);
}

export function createTicketCommand() {
    return new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Thiết lập bảng hỗ trợ ticket')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Đăng bảng hỗ trợ vào một channel')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('Channel đăng bảng ticket')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option
                        .setName('staff_role')
                        .setDescription('Role moderator hỗ trợ ticket')
                        .setRequired(true)
                )
                .addChannelOption(option =>
                    option
                        .setName('category')
                        .setDescription('Category chứa các ticket')
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false)
                )
                .addChannelOption(option =>
                    option
                        .setName('transcript_channel')
                        .setDescription('Channel lưu transcript khi đóng ticket')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false)
                )
        );
}

function ticketPanelEmbed(settings) {
    return new EmbedBuilder()
        .setColor(ticketColor(settings))
        .setAuthor({ name: settings.serverName })
        .setTitle(settings.panelTitle)
        .setDescription([
            settings.panelDescription,
            '',
            '**Quy trình hỗ trợ**',
            '`01`  Chọn Moderator hoặc AI nhanh',
            settings.formEnabled ? '`02`  Điền form hỗ trợ' : '`02`  Mô tả vấn đề trong ticket',
            '`03`  Trao đổi riêng với người hỗ trợ đã chọn'
        ].join('\n'))
        .addFields({
            name: '🔒 Riêng tư',
            value: 'Chỉ bạn và người hỗ trợ đã chọn có thể trò chuyện trong ticket.',
            inline: true
        }, {
            name: '🧾 Lưu trữ',
            value: 'Khi đóng, cuộc trao đổi được xuất thành transcript.',
            inline: true
        })
        .setFooter({ text: `${settings.serverName}  •  Vui lòng chỉ mở một ticket cho mỗi vấn đề` });
}

function ticketPanelComponents() {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('ticket_open:moderator')
            .setLabel('Moderator')
            .setEmoji('🛡️')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('ticket_open:ai')
            .setLabel('AI nhanh')
            .setEmoji('🤖')
            .setStyle(ButtonStyle.Success)
    )];
}

export async function publishTicketPanel(client, input) {
    const settings = await validateTicketSettings(input);
    if (!settings.panelChannelId || !settings.staffRoleId) {
        throw new Error('Chọn panel channel và moderator role trước khi cập nhật panel.');
    }

    const guild = client.guilds.cache.get(TICKET_GUILD_ID) ?? await client.guilds.fetch(TICKET_GUILD_ID);
    await guild.roles.fetch();
    const panelChannel = await guild.channels.fetch(settings.panelChannelId);

    if (!panelChannel || panelChannel.type !== ChannelType.GuildText) {
        throw new Error('Panel channel không tồn tại hoặc không phải text channel.');
    }
    if (!guild.roles.cache.has(settings.staffRoleId)) {
        throw new Error('Moderator role không còn tồn tại trong server.');
    }
    if (settings.categoryId) {
        const category = await guild.channels.fetch(settings.categoryId);
        if (category?.type !== ChannelType.GuildCategory) throw new Error('Category ticket không hợp lệ.');
    }
    if (settings.transcriptChannelId) {
        const transcriptChannel = await guild.channels.fetch(settings.transcriptChannelId);
        if (transcriptChannel?.type !== ChannelType.GuildText) throw new Error('Kênh transcript không hợp lệ.');
    }

    const payload = {
        embeds: [ticketPanelEmbed(settings)],
        components: ticketPanelComponents()
    };
    let panelMessage;

    if (settings.panelMessageId) {
        try {
            panelMessage = await panelChannel.messages.fetch(settings.panelMessageId);
            await panelMessage.edit(payload);
        } catch (error) {
            if (error.code !== 10008 && error.code !== 50001) throw error;
        }
    }

    if (!panelMessage) panelMessage = await panelChannel.send(payload);

    return saveTicketSettings({
        ...settings,
        panelChannelId: panelChannel.id,
        panelMessageId: panelMessage.id
    });
}

function ticketStatusEmbed({ ownerId, staffRoleId, claimedBy, closedBy, supportMode = 'moderator', settings = DEFAULT_TICKET_SETTINGS }) {
    const isClosed = Boolean(closedBy);
    const isClaimed = Boolean(claimedBy);
    const isAI = supportMode === 'ai';
    const embed = new EmbedBuilder()
        .setColor(isClosed ? 0x747F8D : isClaimed ? 0x3BA55D : ticketColor(settings))
        .setAuthor({ name: settings.serverName })
        .setTitle(isClosed ? 'Ticket đã đóng' : settings.ticketTitle)
        .setDescription(isClosed
            ? 'Yêu cầu này đã được xử lý và lưu lại lịch sử trao đổi.'
            : settings.ticketIntro)
        .addFields({
            name: 'Người gửi',
            value: `<@${ownerId}>`,
            inline: true
        }, {
            name: 'Trạng thái',
            value: isClosed ? '⚫ Đã đóng' : isAI ? '🤖 Đang hỗ trợ bằng AI' : isClaimed ? '🟢 Đang được hỗ trợ' : '🟡 Đang chờ moderator',
            inline: true
        }, {
            name: isAI ? 'AI phụ trách' : isClaimed ? 'Moderator phụ trách' : 'Đội hỗ trợ',
            value: isAI ? `<@${AI_BOT_ID}>` : isClaimed ? `<@${claimedBy}>` : `<@&${staffRoleId}>`,
            inline: true
        })
        .setFooter({ text: 'Không gửi thông tin nhạy cảm như mật khẩu hoặc mã xác thực.' })
        .setTimestamp();

    if (closedBy) {
        embed.addFields({ name: 'Đóng bởi', value: `<@${closedBy}>`, inline: true });
    }

    return embed;
}

function ticketActionRow({ claimedBy, closed = false, supportMode = 'moderator' }) {
    if (closed) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ticket_closed')
                .setLabel('Đã đóng')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        );
    }

    const buttons = [];
    if (!claimedBy && supportMode !== 'ai') {
        buttons.push(new ButtonBuilder()
            .setCustomId('ticket_claim')
            .setLabel('Nhận xử lý')
            .setEmoji('🛠️')
            .setStyle(ButtonStyle.Primary));
    }

    buttons.push(new ButtonBuilder()
        .setCustomId('ticket_close')
        .setLabel('Đóng ticket')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger));

    return new ActionRowBuilder().addComponents(...buttons);
}

function isUnknownInteractionError(error) {
    return error?.code === 10062 || error?.rawError?.code === 10062;
}

async function createTicketTranscript(channel) {
    const messages = [];
    let before;

    while (true) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;

        messages.push(...batch.values());
        before = batch.last().id;
    }

    messages.sort((first, second) => first.createdTimestamp - second.createdTimestamp);

    const lines = [
        `TRANSCRIPT  /  #${channel.name}`,
        `Server: ${channel.guild.name} (${channel.guild.id})`,
        `Exported: ${new Date().toISOString()}`,
        '─'.repeat(56),
        ''
    ];
    const maxBytes = 7 * 1024 * 1024;
    let byteCount = Buffer.byteLength(lines.join('\n'), 'utf8');
    let truncated = false;

    for (const message of messages) {
        const embedText = message.embeds
            .map(embed => [
                embed.title,
                embed.description,
                ...embed.fields.map(field => `${field.name}: ${field.value}`)
            ].filter(Boolean).join('\n'))
            .filter(Boolean);
        const attachmentUrls = [...message.attachments.values()].map(attachment => attachment.url);
        const content = [message.cleanContent, ...embedText, ...attachmentUrls].filter(Boolean).join('\n');
        const line = `[${message.createdAt.toISOString()}] ${message.author.tag}\n${content || '(không có nội dung văn bản)'}`;
        const lineBytes = Buffer.byteLength(`${line}\n\n`, 'utf8');

        if (byteCount + lineBytes > maxBytes) {
            truncated = true;
            break;
        }

        lines.push(line, '');
        byteCount += lineBytes;
    }

    if (truncated) lines.push('[Transcript đã được rút gọn do vượt giới hạn 7 MB.]');

    return new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), {
        name: `${channel.name}-transcript.txt`
    });
}

async function setupTicketPanel(interaction) {
    if (interaction.guildId !== TICKET_GUILD_ID) {
        await interaction.reply({
            content: 'Lệnh ticket chỉ dùng trong server được cấu hình.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
            content: 'Bạn cần quyền Manage Server để thiết lập ticket.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const panelChannel = interaction.options.getChannel('channel', true);
    const staffRole = interaction.options.getRole('staff_role', true);
    const category = interaction.options.getChannel('category');
    const transcriptChannel = interaction.options.getChannel('transcript_channel');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const currentSettings = await loadTicketSettings();
        const settings = await publishTicketPanel(interaction.client, {
            ...currentSettings,
            panelChannelId: panelChannel.id,
            panelMessageId: currentSettings.panelChannelId === panelChannel.id ? currentSettings.panelMessageId : '',
            staffRoleId: staffRole.id,
            categoryId: category?.id ?? '',
            transcriptChannelId: transcriptChannel?.id ?? ''
        });
        await interaction.editReply({ content: `Đã lưu cài đặt và cập nhật bảng hỗ trợ tại <#${settings.panelChannelId}>.` });
    } catch (error) {
        console.error('Không thể đăng bảng ticket:', error);
        if (!isUnknownInteractionError(error)) {
            await interaction.editReply({
                content: 'Không gửi được bảng ticket. Hãy kiểm tra quyền gửi tin nhắn và embed của bot.'
            }).catch(replyError => console.error('Không thể cập nhật phản hồi setup ticket:', replyError));
        }
    }
}

function ticketFormModal(settings, supportMode) {
    const modal = new ModalBuilder()
        .setCustomId(`ticket_form:${supportMode}`)
        .setTitle(settings.formTitle);

    modal.addComponents(settings.formQuestions.map((question, index) =>
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId(`answer_${index}`)
                .setLabel(question.label)
                .setPlaceholder(question.placeholder || undefined)
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(question.required)
                .setMaxLength(1000)
        )
    ));

    return modal;
}

async function openTicket(interaction, client, settings, answers = [], supportMode = 'moderator') {
    const { categoryId, staffRoleId, transcriptChannelId } = settings;
    const lockKey = `${interaction.guildId}:${interaction.user.id}`;

    if (ticketCreations.has(lockKey)) {
        await interaction.reply({
            content: 'Ticket của bạn đang được tạo, vui lòng đợi một chút.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    ticketCreations.add(lockKey);
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const existingTicket = interaction.guild.channels.cache.find(channel =>
            channel.type === ChannelType.GuildText &&
            channel.topic?.includes(`ticket-owner:${interaction.user.id}`) &&
            !channel.name.startsWith('closed-')
        );

        if (existingTicket) {
            await interaction.editReply({ content: `Bạn đã có yêu cầu đang mở: ${existingTicket}` });
            return;
        }

        if (supportMode === 'moderator' && !interaction.guild.roles.cache.has(staffRoleId)) {
            await interaction.editReply({ content: 'Role hỗ trợ của bảng ticket không còn tồn tại. Hãy đăng lại bảng ticket.' });
            return;
        }

        if (supportMode === 'ai') {
            try {
                const aiMember = await interaction.guild.members.fetch(AI_BOT_ID);
                if (!aiMember.user.bot) throw new Error('Configured AI account is not a bot.');
            } catch {
                await interaction.editReply({ content: 'Không tìm thấy bot AI trong server. Hãy mời bot AI vào server rồi thử lại.' });
                return;
            }
        }

        const permissionOverwrites = [
            {
                id: interaction.guild.roles.everyone.id,
                deny: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.UseApplicationCommands
                ]
            },
            {
                id: interaction.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.EmbedLinks
                ]
            },
            {
                id: client.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageChannels
                ]
            },
            {
                id: staffRoleId,
                ...(supportMode === 'ai'
                    ? { deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                    : {
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]
                    })
            }
        ];

        if (supportMode === 'ai') {
            permissionOverwrites.push({
                id: AI_BOT_ID,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.EmbedLinks
                ]
            });
        }

        const parent = categoryId !== 'none'
            ? interaction.guild.channels.cache.get(categoryId)
            : null;
        const ticketChannel = await interaction.guild.channels.create({
            name: `ticket-${interaction.user.username}`
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .slice(0, 85),
            type: ChannelType.GuildText,
            ...(parent?.type === ChannelType.GuildCategory ? { parent: parent.id } : {}),
            topic: `ticket-owner:${interaction.user.id};ticket-staff-role:${staffRoleId};ticket-support:${supportMode};ticket-transcript-channel:${transcriptChannelId || 'none'}`,
            permissionOverwrites
        });

        const formDescription = settings.formEnabled && settings.formMode === 'channel'
            ? `\n\n**${settings.formTitle}**\n${settings.formQuestions.map((question, index) => `${index + 1}. ${question.label}${question.required ? ' (bắt buộc)' : ''}`).join('\n')}`
            : '';

        await ticketChannel.send({
            content: supportMode === 'ai'
                ? `<@${AI_BOT_ID}> <@${interaction.user.id}>`
                : `<@&${staffRoleId}> <@${interaction.user.id}>`,
            embeds: [ticketStatusEmbed({ ownerId: interaction.user.id, staffRoleId, supportMode, settings })],
            components: [ticketActionRow({ supportMode })],
            allowedMentions: supportMode === 'ai'
                ? { users: [interaction.user.id, AI_BOT_ID] }
                : { users: [interaction.user.id], roles: [staffRoleId] }
        });
        if (answers.length) {
            const answersEmbed = new EmbedBuilder()
                .setColor(ticketColor(settings))
                .setTitle(settings.formTitle)
                .addFields(answers.map(answer => ({
                    name: answer.label,
                    value: answer.value.slice(0, 1024) || '(Không có câu trả lời)'
                })));
            await ticketChannel.send({ embeds: [answersEmbed] });
        }
        if (formDescription) {
            await ticketChannel.send({
                content: formDescription,
                allowedMentions: { parse: [] }
            });
        }
        recordTicketActivity({
            action: 'created',
            ticketId: ticketChannel.id,
            ticketName: ticketChannel.name,
            ownerId: interaction.user.id,
            supportMode,
            actorId: interaction.user.id
        });
        await interaction.editReply({ content: `Ticket đã sẵn sàng: ${ticketChannel}` });
    } catch (error) {
        console.error('Không thể tạo ticket:', error);
        if (!isUnknownInteractionError(error) && (interaction.deferred || interaction.replied)) {
            await interaction.editReply({
                content: 'Không tạo được ticket. Hãy kiểm tra quyền Manage Channels của bot.'
            }).catch(replyError => console.error('Không thể cập nhật phản hồi tạo ticket:', replyError));
        }
    } finally {
        ticketCreations.delete(lockKey);
    }
}

async function closeTicket(interaction) {
    const channel = interaction.channel;
    const ownerId = channel?.topic?.match(/ticket-owner:(\d+)/)?.[1];
    const claimedBy = channel?.topic?.match(/ticket-claimed-by:(\d+)/)?.[1];
    const staffRoleId = channel?.topic?.match(/ticket-staff-role:(\d+)/)?.[1];

    if (!channel || !ownerId || channel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: 'Không tìm thấy ticket hợp lệ.', flags: MessageFlags.Ephemeral });
        return;
    }

    const isModerator = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.member.roles.cache.has(staffRoleId);
    if (interaction.user.id !== ownerId && interaction.user.id !== claimedBy && !isModerator) {
        await interaction.reply({
            content: 'Chỉ chủ ticket, moderator phụ trách hoặc admin mới có thể đóng ticket.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    if (channel.name.startsWith('closed-')) {
        await interaction.reply({ content: 'Ticket này đã được đóng.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferUpdate();
    let transcriptSaved = false;
    let transcript;
    try {
        transcript = await createTicketTranscript(channel);
        const transcriptChannelId = channel.topic.match(/ticket-transcript-channel:(\d+)/)?.[1];
        const configuredChannel = transcriptChannelId
            ? interaction.guild.channels.cache.get(transcriptChannelId)
            : null;
        if (!configuredChannel?.isTextBased()) throw new Error('Kênh lưu transcript không tồn tại.');
        await configuredChannel.send({
            content: `🧾 Transcript của <#${channel.id}>.`,
            files: [transcript],
            allowedMentions: { parse: [] }
        });
        transcriptSaved = true;
    } catch (error) {
        console.error('Không thể tạo hoặc gửi transcript:', error);
    }

    let transcriptProvided = false;
    if (!transcriptSaved && transcript) {
        try {
            await interaction.followUp({
                content: 'Không lưu được transcript vào kênh lưu trữ. Bản transcript được đính kèm riêng trước khi xóa ticket.',
                files: [transcript],
                flags: MessageFlags.Ephemeral
            });
            transcriptProvided = true;
        } catch (error) {
            console.error('Không thể gửi riêng transcript:', error);
        }
    }

    try {
        await channel.delete(`Ticket closed by ${interaction.user.tag}`);
        recordTicketActivity({
            action: 'deleted',
            ticketId: channel.id,
            ticketName: channel.name,
            ownerId,
            supportMode: channel.topic.match(/ticket-support:(ai|moderator)/)?.[1] || 'moderator',
            actorId: interaction.user.id
        });
    } catch (error) {
        console.error('Không thể xóa ticket:', error);
        await interaction.followUp({
            content: 'Không thể xóa ticket. Hãy kiểm tra quyền Manage Channels của bot.',
            flags: MessageFlags.Ephemeral
        }).catch(replyError => console.error('Không thể thông báo lỗi xóa ticket:', replyError));
        return;
    }

    const transcriptStatus = transcriptSaved
        ? 'Transcript đã được lưu vào kênh lưu trữ.'
        : transcriptProvided
            ? 'Transcript đã được gửi riêng cho bạn.'
            : 'Không thể tạo hoặc lưu transcript.';
    await interaction.followUp({
        content: `Ticket đã được xóa. ${transcriptStatus}`,
        flags: MessageFlags.Ephemeral
    }).catch(error => console.error('Không thể gửi xác nhận xóa ticket:', error));
}

async function claimTicket(interaction) {
    const channel = interaction.channel;
    const ownerId = channel?.topic?.match(/ticket-owner:(\d+)/)?.[1];
    const staffRoleId = channel?.topic?.match(/ticket-staff-role:(\d+)/)?.[1];
    const supportMode = channel?.topic?.match(/ticket-support:(ai|moderator)/)?.[1] || 'moderator';

    if (!channel || !ownerId || channel.type !== ChannelType.GuildText || !staffRoleId) {
        await interaction.reply({ content: 'Ticket này thiếu thông tin role hỗ trợ.', flags: MessageFlags.Ephemeral });
        return;
    }

    if (supportMode === 'ai') {
        await interaction.reply({ content: 'Ticket này đang được AI hỗ trợ.', flags: MessageFlags.Ephemeral });
        return;
    }

    const canClaim = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.member.roles.cache.has(staffRoleId);
    if (!canClaim) {
        await interaction.reply({
            content: 'Chỉ moderator thuộc role hỗ trợ mới có thể nhận ticket.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const alreadyClaimed = channel.topic.match(/ticket-claimed-by:(\d+)/)?.[1];
    if (alreadyClaimed || ticketClaims.has(channel.id)) {
        await interaction.reply({
            content: alreadyClaimed ? `Ticket đã được nhận bởi <@${alreadyClaimed}>.` : 'Moderator khác đang nhận ticket này.',
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    ticketClaims.add(channel.id);
    try {
        await interaction.deferUpdate();
        const settings = await loadTicketSettings();
        await channel.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: true,
            AttachFiles: true,
            EmbedLinks: true
        });
        const topic = channel.topic.replace(/;?ticket-claimed-by:\d+/, '');
        await channel.setTopic(`${topic};ticket-claimed-by:${interaction.user.id}`);
        await interaction.message.edit({
            embeds: [ticketStatusEmbed({ ownerId, staffRoleId, claimedBy: interaction.user.id, settings })],
            components: [ticketActionRow({ claimedBy: interaction.user.id })]
        });
        await channel.send({
            content: `🛠️ <@${interaction.user.id}> đã nhận ticket và là moderator duy nhất có thể trả lời cùng chủ ticket.`,
            allowedMentions: { users: [interaction.user.id] }
        });
        recordTicketActivity({
            action: 'claimed',
            ticketId: channel.id,
            ticketName: channel.name,
            ownerId,
            supportMode: 'moderator',
            actorId: interaction.user.id
        });
    } catch (error) {
        console.error('Không thể nhận ticket:', error);
        await channel.send('Không thể nhận ticket. Hãy kiểm tra quyền quản lý channel của bot.').catch(() => { });
    } finally {
        ticketClaims.delete(channel.id);
    }
}

export async function handleTicketInteraction(interaction, client) {
    if (
        interaction.isCommand() &&
        /(?:^|;)ticket-owner:\d+(?:;|$)/.test(interaction.channel?.topic || '')
    ) {
        await interaction.reply({
            content: 'Không thể sử dụng lệnh ứng dụng trong ticket.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'ticket') {
        await setupTicketPanel(interaction);
        return true;
    }

    if (interaction.isModalSubmit() && (interaction.customId === 'ticket_form' || interaction.customId.startsWith('ticket_form:'))) {
        if (interaction.guildId !== TICKET_GUILD_ID) {
            await interaction.reply({ content: 'Ticket chỉ được sử dụng trong server được cấu hình.', flags: MessageFlags.Ephemeral });
            return true;
        }

        const settings = await loadTicketSettings();
        const answers = settings.formQuestions.map((question, index) => ({
            label: question.label,
            value: interaction.fields.getTextInputValue(`answer_${index}`)
        })).filter(answer => answer.value.trim());

        const supportMode = interaction.customId.split(':')[1] === 'ai' ? 'ai' : 'moderator';
        await openTicket(interaction, client, settings, answers, supportMode);
        return true;
    }

    if (!interaction.isButton() || !interaction.customId.startsWith('ticket_')) {
        return false;
    }

    if (interaction.guildId !== TICKET_GUILD_ID) {
        await interaction.reply({
            content: 'Ticket chỉ được sử dụng trong server được cấu hình.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (interaction.customId.startsWith('ticket_open:')) {
        const settings = await loadTicketSettings();
        const supportMode = interaction.customId === 'ticket_open:ai' ? 'ai' : 'moderator';
        if (!['ticket_open:config', 'ticket_open:moderator', 'ticket_open:ai'].includes(interaction.customId)) {
            const [, categoryId, staffRoleId, transcriptChannelId] = interaction.customId.split(':');
            settings.categoryId = categoryId || settings.categoryId;
            settings.staffRoleId = staffRoleId || settings.staffRoleId;
            settings.transcriptChannelId = transcriptChannelId === 'none'
                ? ''
                : transcriptChannelId || settings.transcriptChannelId;
        }

        if (!settings.staffRoleId) {
            await interaction.reply({
                content: 'Bảng ticket chưa được cấu hình role moderator. Hãy cấu hình lại trên dashboard hoặc chạy /ticket setup.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        if (settings.formEnabled && settings.formMode === 'modal') {
            await interaction.showModal(ticketFormModal(settings, supportMode));
        } else {
            await openTicket(interaction, client, settings, [], supportMode);
        }
    } else if (interaction.customId === 'ticket_claim') {
        await claimTicket(interaction);
    } else if (interaction.customId === 'ticket_close') {
        await closeTicket(interaction);
    }

    return true;
}