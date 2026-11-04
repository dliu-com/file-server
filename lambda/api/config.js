'use strict';

const PREFIX = process.env.PARAMETER_PREFIX || '/files';
// The Entra tenant id is shared across dliu.com apps, so it is read from the central audit stack by its full
// name; the client id and secret stay under this app's own prefix.
const TENANT_PARAM = process.env.TENANT_PARAMETER || '/dliu/entra-tenant-id';
const CLIENT_ID_PARAM = `${PREFIX}/entra-client-id`;
const CLIENT_SECRET_PARAM = `${PREFIX}/entra-client-secret`;
const NAMES = [TENANT_PARAM, CLIENT_ID_PARAM, CLIENT_SECRET_PARAM];
const TTL_MS = 5 * 60 * 1000;

let cached;
let cachedAt = 0;

let ssmClient;
function client() {
  if (!ssmClient) {
    const { SSMClient } = require('@aws-sdk/client-ssm');
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

class NotConfigured extends Error {}

async function loadConfig(ssm = client(), now = Date.now()) {
  if (cached && now - cachedAt < TTL_MS) return cached;
  const { GetParametersCommand } = require('@aws-sdk/client-ssm');
  const result = await ssm.send(new GetParametersCommand({
    Names: NAMES,
    WithDecryption: true,
  }));
  const values = Object.fromEntries((result.Parameters || []).map((p) => [p.Name, p.Value]));
  const missing = NAMES.filter((name) => !values[name]);
  if (missing.length) {
    throw new NotConfigured(`Missing SSM parameters: ${missing.join(', ')}. Run "make set-secrets".`);
  }
  cached = {
    tenantId: values[TENANT_PARAM].trim(),
    clientId: values[CLIENT_ID_PARAM].trim(),
    clientSecret: values[CLIENT_SECRET_PARAM],
    allowedDomain: (process.env.ALLOWED_DOMAIN || process.env.ROOT_DOMAIN || 'dliu.com').trim().toLowerCase(),
  };
  cachedAt = now;
  return cached;
}

function resetConfigCache() {
  cached = undefined;
  cachedAt = 0;
}

module.exports = { loadConfig, resetConfigCache, NotConfigured };
