import {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class PostoraApi implements ICredentialType {
  name = 'postoraApi';
  displayName = 'Postora API';
  documentationUrl = 'https://postora.cloud/docs/api';
  icon = 'file:postora.png' as const;

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
      description: 'Postora API base URL. Only change if using a self-hosted instance.',
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

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials?.baseUrl}}',
      url: '/api/v1/accounts',
    },
  };
}
