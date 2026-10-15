import { Argument, type Command } from 'commander';
import { SkillInstaller, skillClients, type SkillClient, type SkillInstallOptions } from './skill-installer.js';

export function registerSkillCommands(program: Command): void {
  const skill = program.command('skill').description('Install and inspect local llmwiki skills; MCP OAuth is a separate step');
  const installer = new SkillInstaller();
  for (const action of ['install', 'update', 'status'] as const) {
    skill.command(action)
      .description(action === 'status' ? 'Show installed version and local changes' : `${action === 'install' ? 'Install' : 'Update'} canonical skill without changing MCP configuration`)
      .addArgument(new Argument('<client>', 'Agent client').choices([...skillClients]))
      .option('--project <dir>', 'Install or inspect a project instead of the user home')
      .option('--force', 'Replace modified/unmanaged skill files; never changes client settings')
      .action((client: SkillClient, options: SkillInstallOptions) => {
        const status = action === 'status' ? installer.status(client, options) : installer.install(client, action, options);
        console.log(JSON.stringify(status, null, 2));
        console.log('\nSeparate MCP/OAuth step (not performed by this command):');
        console.log('For client setup and login, open <ENGINE_URL>/settings?tab=mcp or read docs/skills.md. Start a new agent session after installing.');
        if (client === 'hermes' && options.project) {
          console.log('Hermes project skills require a git project root and separate approval: hermes skills trust <PROJECT_DIR>. This command does not modify project trust.');
        }
      });
  }
}
