INSERT INTO public.user_roles (user_id, role)
SELECT '44f5c86e-4a52-4345-b3f5-7a07e07ee9a2', 'admin'::app_role
WHERE EXISTS (
  SELECT 1
  FROM auth.users
  WHERE id = '44f5c86e-4a52-4345-b3f5-7a07e07ee9a2'
)
ON CONFLICT (user_id, role) DO NOTHING;
