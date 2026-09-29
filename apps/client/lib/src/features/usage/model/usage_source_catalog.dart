/// Usage sources in Tokdash's catalog. This is presentation metadata, never a
/// session adapter or quota-provider allowlist. Unknown sources remain visible.
const Map<String, String> usageSourceNames = {
  'claude': 'Claude Code',
  'codex': 'Codex',
  'opencode': 'OpenCode',
  'gemini_cli': 'Gemini CLI',
  'antigravity_cli': 'Antigravity',
  'amp': 'Amp',
  'openclaw': 'OpenClaw',
  'kimi': 'Kimi',
  'grok': 'Grok',
  'pi_agent': 'Pi',
  'omp': 'Oh My Pi',
  'kilocode': 'Kilo Code',
  'cline': 'Cline',
  'copilot_cli': 'GitHub Copilot CLI',
  'hermes': 'Hermes',
  'mimo': 'MiMo',
  'dsh': 'DeepSeek',
  'reasonix': 'Reasonix',
  'zcode': 'ZCode',
  'workbuddy': 'WorkBuddy',
  'qoder': 'Qoder',
  'qoder_cli': 'Qoder CLI',
  'zed': 'Zed',
  'qwen_code': 'Qwen Code',
  'crush': 'Crush',
  'minimax': 'MiniMax Code',
  'muse': 'Muse Code',
  'devin': 'Devin CLI',
};

/// Prefer a server-supplied human name, then catalog branding, then its id.
String usageSourceDisplayName(String tool, [String? label]) =>
    label ?? usageSourceNames[tool] ?? tool;
