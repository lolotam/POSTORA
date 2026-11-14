import { supabase } from '@/integrations/supabase/client';

/** Advance by the returned count: PostgREST may cap pages below the requested size. */
export async function fetchModelCatalogue() {
  const catalogue = [];
  for (;;) {
    const { data: page, error } = await supabase.from('ai_models')
      .select('*, ai_providers(provider_code, name)').in('auth_method', ['api_key', 'oauth'])
      .order('name').order('id').range(catalogue.length, catalogue.length + 499);
    if (error) throw new Error('The model catalogue could not be read.');
    if (!page?.length) return { data: catalogue, error: null };
    catalogue.push(...page);
  }
}
