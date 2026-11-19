export function restrictCtfTools(ctx) {
  // Call on the Agent context after binding its CTF preset.
  ctx.tools.presentAs('native');
  ctx.tools.restrict({ allow: ['ctf_workspace'] });
  ctx.tools.guard(exec => exec.name === 'ctf_workspace' ? undefined : 'CTF preset only permits ctf_workspace');
}
