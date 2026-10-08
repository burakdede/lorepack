import type { CommandDefinition } from '../framework/program.js';
import { registerCommands } from './index.js';

const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
type Shell = (typeof SHELLS)[number];

export function completionCommand(): CommandDefinition {
  return {
    name: 'completion',
    description: 'Print shell completion for lorepack.',
    arguments: [
      {
        name: 'shell',
        description: `one of ${SHELLS.join(', ')}`,
        values: SHELLS,
      },
    ],
    handler: (args) => {
      const shell = args[0] as Shell | undefined;
      if (shell === undefined || !SHELLS.includes(shell)) {
        return {
          human: `Choose a shell: ${SHELLS.join(', ')}. Example: lorepack completion zsh`,
        };
      }

      const commands = registerCommands()
        .map((command) => command.name)
        .filter((name) => name !== 'completion');
      return { human: renderCompletion(shell, commands) };
    },
  };
}

function renderCompletion(shell: Shell, commands: readonly string[]): string {
  const list = commands.join(' ');
  switch (shell) {
    case 'bash':
      return `# Add this once: eval "$(lorepack completion bash)"
_lorepack_completions() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${list}" -- "\${current}") )
  else
    COMPREPLY=( $(compgen -W "--help --json --verbose --no-color --cwd" -- "\${current}") )
  fi
}
complete -F _lorepack_completions lorepack
`;
    case 'zsh':
      return `# Add this once: eval "$(lorepack completion zsh)"
_lorepack() {
  _arguments '1:command:(${list})' '*:option:(--help --json --verbose --no-color --cwd)'
}
compdef _lorepack lorepack
`;
    case 'fish':
      return `# Add this once: lorepack completion fish | source
complete -c lorepack -f -n "__fish_use_subcommand" -a "${list}"
complete -c lorepack -f -n "not __fish_use_subcommand" -a "--help --json --verbose --no-color --cwd"
`;
    case 'powershell':
      return `# Add this once in your PowerShell profile: lorepack completion powershell | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName lorepack -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  '${list} --help --json --verbose --no-color --cwd'.Split(' ') |
    Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_) }
}
`;
  }
}
