-- Insert the missing subscription for dr.vet.waleeedtam@gmail.com
INSERT INTO user_subscriptions (
  user_id,
  plan_id,
  status,
  stripe_customer_id,
  stripe_subscription_id,
  current_period_start,
  current_period_end
)
SELECT
  '43cc06f3-e125-44b0-836f-e6ee699a3109',
  '23d9c7b3-952f-4ff2-9997-f655552c4055',
  'active',
  'cus_TmzC0AiO5Vztfw',
  'sub_1SpPt00hJJ11XlNOssZ1jjHW',
  '2025-01-14T04:17:04Z',
  '2025-02-13T04:17:04Z'
WHERE EXISTS (
  SELECT 1
  FROM auth.users
  WHERE id = '43cc06f3-e125-44b0-836f-e6ee699a3109'
)
AND EXISTS (
  SELECT 1
  FROM subscription_plans
  WHERE id = '23d9c7b3-952f-4ff2-9997-f655552c4055'
);
