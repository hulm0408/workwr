// Point git at the tracked hooks directory. Cross-platform, no dependencies.
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
  console.log('Git hooks installed: core.hooksPath=.githooks');
  console.log('Pre-commit now runs gitleaks on staged changes.');
} catch (error) {
  console.error('Could not install git hooks:', error?.message || error);
  process.exit(1);
}
