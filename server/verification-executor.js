const fs = require('fs');
const path = require('path');

const resolveTargetSubDir = (stack, repoPath) => {
  if (stack === 'dotnet') {
    const findSlnFile = (dir) => {
      const files = fs.readdirSync(dir);
      const sln = files.find(f => f.endsWith('.sln'));
      if (sln) return path.join(dir, sln);
      for (const cand of ['aspnet-core', 'backend', 'src', 'server']) {
        const full = path.join(dir, cand);
        if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
          const subFiles = fs.readdirSync(full);
          const subSln = subFiles.find(sf => sf.endsWith('.sln')) || subFiles.find(sf => sf.endsWith('.csproj'));
          if (subSln) return path.join(full, subSln);
        }
      }
      return null;
    };
    const slnPath = findSlnFile(repoPath);
    return slnPath ? path.dirname(slnPath) : repoPath;
  }

  if (stack === 'angular' || stack === 'nodejs') {
    const markers = stack === 'angular' ? ['angular.json', 'package.json'] : ['package.json'];
    for (const m of markers) {
      if (fs.existsSync(path.join(repoPath, m))) return repoPath;
    }
    for (const cand of ['angular', 'frontend', 'client', 'src', 'server', 'backend', 'api']) {
      const full = path.join(repoPath, cand);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        for (const m of markers) {
          if (fs.existsSync(path.join(full, m))) return full;
        }
      }
    }
  }
  return repoPath;
};

const ensureDependenciesForStack = async ({ stack, targetSubDir, fixId, runCommand, updateFixStep }) => {
  if (stack !== 'angular' && stack !== 'nodejs') return;
  if (fs.existsSync(path.join(targetSubDir, 'node_modules'))) return;

  await updateFixStep(fixId, `Verification (${stack})`, 'node_modules missing, running npm install...');
  try {
    const installCmd = stack === 'angular'
      ? 'npm install -f --include=dev --legacy-peer-deps'
      : 'npm install --production --prefer-offline --no-audit --no-fund';
    await runCommand(installCmd, targetSubDir);
  } catch (e) {
    await updateFixStep(fixId, `Verification (${stack})`, 'npm install failed, retrying with mirror registry (npmmirror.com)...');
    const mirrorCmd = stack === 'angular'
      ? 'npm install -f --include=dev --legacy-peer-deps --registry=https://registry.npmmirror.com'
      : 'npm install --production --prefer-offline --no-audit --no-fund --registry=https://registry.npmmirror.com';
    await runCommand(mirrorCmd, targetSubDir);
  }
};

const collectVerificationConfigFiles = (stack, targetSubDir) => {
  const configFiles = [];
  ['package.json', 'angular.json', 'tsconfig.json', 'README.md'].forEach(f => {
    const p = path.join(targetSubDir, f);
    if (fs.existsSync(p)) configFiles.push({ name: f, content: fs.readFileSync(p, 'utf8').substring(0, 5000) });
  });
  if (stack === 'dotnet') {
    fs.readdirSync(targetSubDir).filter(f => f.endsWith('.sln') || f.endsWith('.csproj')).forEach(f => {
      configFiles.push({ name: f, content: fs.readFileSync(path.join(targetSubDir, f), 'utf8').substring(0, 3000) });
    });
  }
  return configFiles;
};

const runValidationPipelineOnce = async ({ stack, pipeline, targetSubDir, runCommand, updateFixStep, fixId }) => {
  for (const step of pipeline) {
    await updateFixStep(fixId, `Verification (${stack})`, `Running [${step.name}] "${step.command}" in ${targetSubDir}...`);
    const vResult = await runCommand(step.command, targetSubDir);
    await updateFixStep(fixId, `Verification Success (${stack})`, `[${step.name}] ${(vResult.stdout || '').substring(0, 500)}`);
  }
};

module.exports = {
  resolveTargetSubDir,
  ensureDependenciesForStack,
  collectVerificationConfigFiles,
  runValidationPipelineOnce,
};
