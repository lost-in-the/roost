const PLUGIN_ID = 'roost-acceptance';
const REVERSIBLE_TOOL = 'roost_reversible_probe';
const IRREVERSIBLE_TOOL = 'roost_irreversible_probe';
const STATUS_TOOL = 'session_status';

const NO_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

function result(text) {
  return {
    content: [{ type: 'text', text }],
    details: { completed: true },
  };
}

let irreversibleCount = 0;

export default {
  id: PLUGIN_ID,
  name: 'Roost Approval Acceptance',
  description: 'Bounded, no-secret live approval probes for Roost.',
  register(api) {
    api.registerTool({
      name: REVERSIBLE_TOOL,
      description: 'Run the side-effect-free Roost approval probe.',
      parameters: NO_PARAMS,
      async execute() {
        return result('Roost reversible probe completed; no state changed.');
      },
    });

    api.registerTool({
      name: IRREVERSIBLE_TOOL,
      description: 'Increment a process-local acceptance counter once.',
      parameters: NO_PARAMS,
      async execute() {
        irreversibleCount += 1;
        return {
          ...result('Roost irreversible probe completed; no persistent state changed.'),
          details: { completed: true, count: irreversibleCount },
        };
      },
    });

    api.on('before_tool_call', (event) => {
      if (event.toolName === STATUS_TOOL) {
        return {
          requireApproval: {
            pluginId: PLUGIN_ID,
            title: 'Allow safe Roost status check?',
            description: 'Reads the current session status without changing it.',
            severity: 'info',
            timeoutMs: 120_000,
            allowedDecisions: ['allow-once', 'deny'],
          },
        };
      }
      if (event.toolName === REVERSIBLE_TOOL) {
        return {
          requireApproval: {
            pluginId: PLUGIN_ID,
            title: 'Allow safe Roost probe?',
            description: 'Runs a side-effect-free acceptance probe.',
            severity: 'info',
            timeoutMs: 120_000,
            allowedDecisions: ['allow-once', 'deny'],
          },
        };
      }
      if (event.toolName === IRREVERSIBLE_TOOL) {
        return {
          requireApproval: {
            pluginId: PLUGIN_ID,
            title: 'Allow irreversible Roost probe?',
            description: 'Runs a harmless but deliberately irreversible acceptance probe.',
            severity: 'warning',
            timeoutMs: 120_000,
            allowedDecisions: ['allow-once', 'deny'],
          },
        };
      }
    }, {
      matcher: [STATUS_TOOL, REVERSIBLE_TOOL, IRREVERSIBLE_TOOL],
      registrationId: 'roost-acceptance-approval-gate',
      priority: 100,
    });
  },
};
