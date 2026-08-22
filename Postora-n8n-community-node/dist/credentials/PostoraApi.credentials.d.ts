import { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';
export declare class PostoraApi implements ICredentialType {
    name: string;
    displayName: string;
    documentationUrl: string;
    icon: "file:postora.png";
    properties: INodeProperties[];
    authenticate: IAuthenticateGeneric;
    test: ICredentialTestRequest;
}
