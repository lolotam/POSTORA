import {
  IAuthenticateGeneric,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class PostoraApi implements ICredentialType {
  name = 'postoraApi';
  displayName = 'Postora API';
  documentationUrl = 'https://postora.cloud/docs/api';

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'Your Postora API key. Find it in Settings → API Keys at postora.cloud.',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.postora.cloud/functions/v1/n8n-api',
      description: 'Postora backend n8n-api function URL. Defaults to the hosted Postora backend (https://api.postora.cloud/functions/v1/n8n-api). Change only if you run a self-hosted Postora deployment with a different API host.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        'x-api-key': '={{$credentials.apiKey}}',
      },
    },
  };
}
