INSERT INTO public.user_roles (user_id, role)
SELECT 'aca32ca0-a63a-41d5-9bc1-45a471b2faae', 'admin'::app_role
WHERE EXISTS (
  SELECT 1
  FROM auth.users
  WHERE id = 'aca32ca0-a63a-41d5-9bc1-45a471b2faae'
)
ON CONFLICT (user_id, role) DO NOTHING;
