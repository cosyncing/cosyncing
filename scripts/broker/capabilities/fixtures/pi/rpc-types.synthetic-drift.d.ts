export type RpcCommand =
  | { id: string; type: 'get_state' }
  | { id: string; type: 'get_messages' }
  | { id: string; type: 'prompt'; message: string }
  | { id: string; type: 'abort' }
  | { id: string; type: 'compact'; customInstructions?: string }
  | { id: string; type: 'get_available_models' }
  | { id: string; type: 'set_model'; provider?: string; modelId: string }
  | { id: string; type: 'set_thinking_level'; level: string }
  | { id: string; type: 'get_commands' }
  | { id: string; type: 'extension_ui_request' }
  | { id: string; type: 'set_session_name'; name: string }
  | { id: string; type: 'get_session_stats' }
  | { id: string; type: 'import'; path: string }
  | { id: string; type: 'export_html' }
  | { id: string; type: 'fork' }
  | { id: string; type: 'clone' }
  | { id: string; type: 'switch_session' }
  | { id: string; type: 'synthetic_new_command' };
