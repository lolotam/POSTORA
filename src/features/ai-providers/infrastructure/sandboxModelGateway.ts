import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { groupSchema } from './chatListGateway';

const schema = z.discriminatedUnion('enabled', [z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), contract: z.literal(1), groups: z.array(groupSchema) })]);
export async function fetchSandboxModelPolicy() {
  const { data, error } = await supabase.functions.invoke('ai-agent-reply', { body: { action: 'sandbox-model-policy' }, timeout: 30_000 });
  const result = schema.safeParse(data);
  if (error || !result.success) throw new Error('Sandbox model choices unavailable. Retry after the server contract is deployed.');
  return result.data;
}
