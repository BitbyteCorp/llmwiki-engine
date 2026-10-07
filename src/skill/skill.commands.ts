import { Argument, type Command } from 'commander';
import { SkillInstaller, skillClients, type SkillClient, type SkillInstallOptions } from './skill-installer.js';

const oauthSteps: Record<SkillClient, string> = {
  'claude-code': 'Register the engine URL separately: claude mcp add --transport http --scope user llmwiki <ENGINE_URL>/mcp (use --scope project for project scope). Then open /mcp in Claude Code and complete browser OAuth.',
  codex: 'Add [mcp_servers.llmwiki] with url = "<ENGINE_URL>/mcp" to your existing ~/.codex/config.toml (or trusted project .codex/config.toml), preserving other settings. Then run: codex mcp login llmwiki',
  hermes: 'Merge llmwiki: { url: "<ENGINE_URL>/mcp", auth: oauth } under mcp_servers in your existing ~/.hermes/config.yaml, preserving other settings. Then run in a separate terminal: hermes mcp login llmwiki',
};

export function registerSkillCommands(program: Command): void {
  const skill = program.command('skill').description('Install and inspect local llmwiki skills; MCP OAuth is a separate step');
  const installer = new SkillInstaller();
  for (const action of ['install', 'update', 'status'] as const) {
    skill.command(action)
      .description(action === 'status' ? 'Show installed version and local changes' : `${action === 'install' ? 'Install' : 'Update'} canonical skill and client templates without changing MCP configuration`)
      .addArgument(new Argument('<client>', 'Agent client').choices([...skillClients]))
      .option('--project <dir>', 'Install or inspect a project instead of the user home')
      .option('--force', 'Replace modified/unmanaged skill files; never changes client settings')
      .action((client: SkillClient, options: SkillInstallOptions) => {
        const status = action === 'status' ? installer.status(client, options) : installer.install(client, action, options);
        console.log(JSON.stringify(status, null, 2));
        console.log('\nSeparate MCP/OAuth step (not performed by this command):');
        console.log(oauthSteps[client]);
        console.log('Replace <ENGINE_URL> with the engine base URL. No secrets or active MCP configuration are written. Start a new agent session after installing.');
        if (client === 'hermes' && options.project) {
          console.log('Hermes project skills require a git project root and separate approval: hermes skills trust <PROJECT_DIR>. This command does not modify project trust.');
        }
      });
  }
}
