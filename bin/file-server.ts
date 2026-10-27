#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { FileServerStack } from '../lib/file-server-stack';
import site from '../config/site.json';

const region = process.env.CDK_DEFAULT_REGION || 'eu-west-1';
// Imports the traffic-monitor exports, which live in eu-west-1 with the other site stacks.
if (region !== 'eu-west-1') throw new Error('FileServer must be deployed to eu-west-1, alongside the other site stacks.');

const app = new App();
for (const [key, value] of Object.entries({ service: 'file-server', Project: 'files.dliu.com' })) Tags.of(app).add(key, value);
new FileServerStack(app, 'FileServer', {
  subdomain: site.subdomain,
  frameAncestors: site.frameAncestors,
  maxUploadBytes: site.maxUploadGiB * 1024 ** 3,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});
