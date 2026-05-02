import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
} from 'discord.js';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Config, Workspace } from './config.js';
import { expandHome } from './workspace-binding.js';

export type AuditSeverity = 'ok' | 'warning' | 'critical';

export interface AuditFinding {
  severity: AuditSeverity;
  title: string;
  detail?: string;
}

export interface AuditSection {
  title: string;
  findings: AuditFinding[];
}

export interface SecurityAudit {
  severity: AuditSeverity;
  workspace?: Workspace;
  sections: AuditSection[];
}

interface AuditInput {
  cfg: Config;
  configPath: string;
  guild: Guild;
  channel: TextChannel;
  botMember: GuildMember | null;
}

const severityRank: Record<AuditSeverity, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
};

const requiredBotPermissions = [
  { title: 'View channel', flag: PermissionFlagsBits.ViewChannel, critical: true },
  { title: 'Send messages', flag: PermissionFlagsBits.SendMessages, critical: true },
  { title: 'Read message history', flag: PermissionFlagsBits.ReadMessageHistory, critical: false },
  { title: 'Attach files', flag: PermissionFlagsBits.AttachFiles, critical: false },
  { title: 'Embed links', flag: PermissionFlagsBits.EmbedLinks, critical: false },
  { title: 'Use slash commands', flag: PermissionFlagsBits.UseApplicationCommands, critical: false },
] as const;

const broadBotPermissions = [
  { title: 'Administrator', flag: PermissionFlagsBits.Administrator },
  { title: 'Manage channels', flag: PermissionFlagsBits.ManageChannels },
  { title: 'Manage server', flag: PermissionFlagsBits.ManageGuild },
  { title: 'Manage roles', flag: PermissionFlagsBits.ManageRoles },
  { title: 'Mention everyone', flag: PermissionFlagsBits.MentionEveryone },
] as const;

function finding(severity: AuditSeverity, title: string, detail?: string): AuditFinding {
  return detail === undefined ? { severity, title } : { severity, title, detail };
}

function maxSeverity(findings: readonly AuditFinding[]): AuditSeverity {
  return findings.reduce<AuditSeverity>(
    (current, item) =>
      severityRank[item.severity] > severityRank[current] ? item.severity : current,
    'ok',
  );
}

function maxSectionSeverity(sections: readonly AuditSection[]): AuditSeverity {
  return sections.reduce<AuditSeverity>((current, section) => {
    const sectionSeverity = maxSeverity(section.findings);
    return severityRank[sectionSeverity] > severityRank[current] ? sectionSeverity : current;
  }, 'ok');
}

function shortId(id: string): string {
  if (id.length <= 8) {
    return id;
  }

  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function roleNames(roles: readonly Role[], limit = 6): string {
  const names = roles.slice(0, limit).map((role) => `@${role.name}`);
  const remaining = roles.length - names.length;

  return remaining > 0 ? `${names.join(', ')} +${remaining} more` : names.join(', ');
}

function channelVisibleRoles(guild: Guild, channel: TextChannel): Role[] {
  return [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.roles.everyone.id)
    .filter((role) => !role.managed)
    .filter((role) => channel.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel) === true)
    .sort((a, b) => b.position - a.position);
}

function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function configuredWorkspaceRoots(cfg: Config): string[] {
  return cfg.security.workspace_roots.map((root) => path.resolve(expandHome(root)));
}

function broadCwdReason(cwd: string): string | undefined {
  const resolved = path.resolve(expandHome(cwd));
  const home = path.resolve(os.homedir());
  const devRoot = path.join(home, 'Dev');
  const parsed = path.parse(resolved);

  if (resolved === parsed.root) {
    return 'filesystem root';
  }

  if (resolved === home) {
    return 'home directory';
  }

  if (resolved === devRoot) {
    return 'default Dev root';
  }

  return undefined;
}

function auditChannelVisibility(cfg: Config, guild: Guild, channel: TextChannel): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const everyoneCanView =
    channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) === true;

  if (everyoneCanView) {
    findings.push(
      finding(
        cfg.security.warn_public_bind ? 'warning' : 'ok',
        '@everyone can view this channel',
        'People outside discord.user_allowlist may still see agent output, diffs, logs, and uploaded files.',
      ),
    );
  } else {
    findings.push(finding('ok', '@everyone cannot view this channel'));
  }

  const visibleRoles = everyoneCanView ? [] : channelVisibleRoles(guild, channel);
  if (visibleRoles.length > 0) {
    findings.push(
      finding(
        'warning',
        `${visibleRoles.length} role(s) can view this channel`,
        `Review members of ${roleNames(visibleRoles)}. They may see output even if they cannot run the bot.`,
      ),
    );
  } else if (!everyoneCanView) {
    findings.push(finding('ok', 'No extra role-level channel visibility detected'));
  }

  return findings;
}

async function auditAllowlistVisibility(
  cfg: Config,
  guild: Guild,
  channel: TextChannel,
): Promise<AuditFinding[]> {
  const missing: string[] = [];
  const cannotUse: string[] = [];

  for (const userId of cfg.discord.user_allowlist) {
    const member =
      guild.members.cache.get(userId) ??
      (await guild.members.fetch(userId).catch(() => undefined));

    if (member === undefined) {
      missing.push(shortId(userId));
      continue;
    }

    const permissions = channel.permissionsFor(member);
    if (
      permissions === null ||
      !permissions.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.SendMessages)
    ) {
      cannotUse.push(shortId(userId));
    }
  }

  const findings: AuditFinding[] = [];
  if (missing.length > 0) {
    findings.push(
      finding(
        'warning',
        'Some allowlisted users could not be checked',
        `User IDs: ${missing.join(', ')}`,
      ),
    );
  }

  if (cannotUse.length > 0) {
    findings.push(
      finding(
        'warning',
        'Some allowlisted users cannot use this channel',
        `User IDs: ${cannotUse.join(', ')}`,
      ),
    );
  }

  if (missing.length === 0 && cannotUse.length === 0) {
    findings.push(finding('ok', 'Allowlisted users can view and send here'));
  }

  return findings;
}

function auditBotPermissions(channel: TextChannel, botMember: GuildMember | null): AuditFinding[] {
  if (botMember === null) {
    return [finding('critical', 'Bot guild member could not be resolved')];
  }

  const permissions = channel.permissionsFor(botMember);
  if (permissions === null) {
    return [finding('critical', 'Bot permissions could not be resolved for this channel')];
  }

  const findings = requiredBotPermissions.map((item) =>
    permissions.has(item.flag)
      ? finding('ok', `Bot has ${item.title}`)
      : finding(item.critical ? 'critical' : 'warning', `Bot is missing ${item.title}`),
  );

  for (const item of broadBotPermissions) {
    if (permissions.has(item.flag)) {
      findings.push(
        finding(
          'warning',
          `Bot has broad permission: ${item.title}`,
          'The bridge usually does not need this permission for normal operation.',
        ),
      );
    }
  }

  if (!broadBotPermissions.some((item) => permissions.has(item.flag))) {
    findings.push(finding('ok', 'No broad bot permissions detected'));
  }

  return findings;
}

function auditWorkspacePath(
  cfg: Config,
  workspace: Workspace,
  options: { checkExists: false },
): AuditFinding[];
function auditWorkspacePath(
  cfg: Config,
  workspace: Workspace,
  options?: { checkExists?: true },
): Promise<AuditFinding[]>;
function auditWorkspacePath(
  cfg: Config,
  workspace: Workspace,
  options: { checkExists?: boolean } = {},
): AuditFinding[] | Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const cwd = path.resolve(expandHome(workspace.cwd));

  if (path.isAbsolute(expandHome(workspace.cwd))) {
    findings.push(finding('ok', 'Workspace cwd is absolute'));
  } else {
    findings.push(finding('critical', 'Workspace cwd is not absolute', workspace.cwd));
  }

  const roots = configuredWorkspaceRoots(cfg);
  if (roots.length > 0) {
    const matchingRoot = roots.find((root) => pathInside(root, cwd));
    if (matchingRoot === undefined) {
      findings.push(
        finding(
          'warning',
          'Workspace cwd is outside configured workspace roots',
          `cwd: ${cwd}`,
        ),
      );
    } else {
      findings.push(finding('ok', 'Workspace cwd is inside a configured root'));
    }
  }

  if (cfg.security.warn_broad_cwd) {
    const reason = broadCwdReason(cwd);
    if (reason !== undefined) {
      findings.push(
        finding(
          'warning',
          'Workspace cwd is broad',
          `${cwd} looks like a ${reason}. Use this intentionally, usually for an operator channel.`,
        ),
      );
    }
  }

  if (options.checkExists === false) {
    return findings;
  }

  return (async () => {
    try {
      const cwdStat = await stat(cwd);
      if (cwdStat.isDirectory()) {
        findings.push(finding('ok', 'Workspace cwd exists'));
      } else {
        findings.push(finding('critical', 'Workspace cwd is not a directory', cwd));
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        findings.push(finding('critical', 'Workspace cwd does not exist', cwd));
      } else {
        findings.push(finding('warning', 'Workspace cwd could not be checked', String(error)));
      }
    }

    return findings;
  })();
}

async function auditWorkspace(cfg: Config, channel: TextChannel): Promise<AuditFinding[]> {
  const workspace = cfg.workspaces.find((candidate) => candidate.channel_id === channel.id);
  if (workspace === undefined) {
    return [
      finding(
        'ok',
        'This channel is not bound to a workspace',
        'Run /bind only after reviewing the channel visibility above.',
      ),
    ];
  }

  return [
    finding('ok', `Bound workspace: ${workspace.name}`),
    finding('ok', `Provider: ${workspace.provider}`),
    ...(await auditWorkspacePath(cfg, workspace)),
  ];
}

async function auditConfig(cfg: Config, configPath: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const resolvedConfigPath = path.resolve(configPath);

  if (process.platform === 'win32') {
    findings.push(finding('ok', 'Config file permission check skipped on Windows'));
  } else {
    try {
      const configStat = await stat(resolvedConfigPath);
      const openBits = configStat.mode & 0o077;

      if (openBits === 0) {
        findings.push(finding('ok', 'config.json is private to the owner'));
      } else {
        findings.push(
          finding(
            'critical',
            'config.json is readable or writable by group/others',
            `mode: ${(configStat.mode & 0o777).toString(8).padStart(4, '0')}`,
          ),
        );
      }
    } catch (error) {
      findings.push(finding('warning', 'config.json permissions could not be checked', String(error)));
    }
  }

  if (cfg.voice.server.enabled) {
    if (isLoopbackHost(cfg.voice.server.host)) {
      findings.push(finding('ok', 'Voice transcribe server is loopback-only'));
    } else {
      findings.push(finding('ok', 'Voice transcribe server is exposed with a token'));
    }
  } else {
    findings.push(finding('ok', 'Voice transcribe server is disabled'));
  }

  if (cfg.voice.enabled && cfg.voice.provider === 'http' && cfg.voice.http.token === undefined) {
    findings.push(
      finding(
        'warning',
        'Voice HTTP client has no token configured',
        'This is fine only if the transcribe endpoint is intentionally unauthenticated on a trusted network.',
      ),
    );
  }

  if (cfg.claude.approval.enabled) {
    findings.push(finding('ok', 'Claude Discord approval is enabled'));
  } else if (cfg.claude.permission_mode === 'bypassPermissions') {
    findings.push(
      finding(
        'warning',
        'Claude runs with bypassPermissions and bridge approval is disabled',
        'Claude tool execution will rely on your local Claude Code policy rather than Discord buttons.',
      ),
    );
  }

  if (cfg.codex.sandbox_mode === 'danger-full-access') {
    findings.push(
      finding(
        'warning',
        'Codex sandbox_mode is danger-full-access',
        'Use only for trusted workspaces and trusted Discord channels.',
      ),
    );
  } else {
    findings.push(finding('ok', `Codex sandbox_mode is ${cfg.codex.sandbox_mode}`));
  }

  if (cfg.codex.approval_policy === 'never') {
    findings.push(finding('warning', 'Codex approval_policy is never'));
  }

  return findings;
}

export function isProblemFinding(finding: AuditFinding): boolean {
  return finding.severity !== 'ok';
}

export function auditBindPreview(input: {
  cfg: Config;
  guild: Guild;
  channel: TextChannel;
  workspace: Workspace;
}): AuditFinding[] {
  return [
    ...auditChannelVisibility(input.cfg, input.guild, input.channel),
    ...auditWorkspacePath(input.cfg, input.workspace, { checkExists: false }),
  ].filter(isProblemFinding);
}

export async function auditSecurity(input: AuditInput): Promise<SecurityAudit> {
  const workspace = input.cfg.workspaces.find(
    (candidate) => candidate.channel_id === input.channel.id,
  );
  const sections: AuditSection[] = [
    {
      title: 'Channel visibility',
      findings: [
        ...auditChannelVisibility(input.cfg, input.guild, input.channel),
        ...(await auditAllowlistVisibility(input.cfg, input.guild, input.channel)),
      ],
    },
    {
      title: 'Bot permissions',
      findings: auditBotPermissions(input.channel, input.botMember),
    },
    {
      title: 'Workspace',
      findings: await auditWorkspace(input.cfg, input.channel),
    },
    {
      title: 'Config',
      findings: await auditConfig(input.cfg, input.configPath),
    },
  ];

  return {
    severity: maxSectionSeverity(sections),
    workspace,
    sections,
  };
}
