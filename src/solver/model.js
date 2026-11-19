export function modelFromEnvironment(env = process.env) {
  const model = env.CTF_MODEL_NAME;
  const key = env.CTF_MODEL_API_KEY;
  if (!model || !env.CTF_MODEL_BASE_URL) throw new Error('Configure CTF_MODEL_NAME and CTF_MODEL_BASE_URL');
  const base = new URL(env.CTF_MODEL_BASE_URL);
  const loopback = ['127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(loopback && base.protocol === 'http:'))
    || base.username || base.password || base.search || base.hash || (!loopback && !key)) {
    throw new Error('Use an HTTPS model endpoint and API key, or an explicit loopback endpoint');
  }
  base.pathname = base.pathname.replace(/\/$/, '') + '/chat/completions';

  return {
    model,
    async complete(messages, maxTokens) {
      let response;
      try {
        response = await fetch(base, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens })
        });
      } catch {
        throw new Error('MODEL_TRANSPORT_FAILED');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('MODEL_HTTP_' + response.status);
      }
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 128 * 1024) throw new Error('MODEL_RESPONSE_LIMIT');
          chunks.push(chunk);
        }
      } catch (error) {
        if (error.message === 'MODEL_RESPONSE_LIMIT') throw error;
        throw new Error('MODEL_TRANSPORT_FAILED');
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('MODEL_INVALID_RESPONSE'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('MODEL_INVALID_RESPONSE');
      }
      const text = payload.choices?.[0]?.message?.content;
      const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
      const usage = { input_tokens: token(payload.usage?.prompt_tokens), output_tokens: token(payload.usage?.completion_tokens) };
      let action;
      try {
        action = JSON.parse(text);
        if (!action || typeof action !== 'object' || Array.isArray(action)) action = null;
      } catch { action = null; }
      return { action, usage };
    }
  };
}
