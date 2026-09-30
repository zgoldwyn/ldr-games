-- Initial Couples Quiz catalog and stable presentation order.
alter table quiz_defs
  add column if not exists position integer not null default 0;

alter table quiz_questions
  add column if not exists position integer not null default 0;

insert into quiz_defs (id, theme, position)
values
  ('10000000-0000-4000-8000-000000000001', 'Favorites & Comforts', 1),
  ('10000000-0000-4000-8000-000000000002', 'Our Story', 2),
  ('10000000-0000-4000-8000-000000000003', 'Future Us', 3)
on conflict (id) do update set
  theme = excluded.theme,
  position = excluded.position;

insert into quiz_questions (id, quiz_id, type, prompt, choices, position)
values
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'multiple_choice',
    'My ideal cozy evening includes…',
    '["A movie marathon", "Cooking together", "Games and snacks", "A long conversation"]'::jsonb,
    1
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'multiple_choice',
    'When I need cheering up, I most want…',
    '["A pep talk", "A distraction", "Quiet company", "A sweet surprise"]'::jsonb,
    2
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'multiple_choice',
    'My dream weekend starts with…',
    '["Sleeping in", "An early adventure", "Breakfast out", "A slow morning at home"]'::jsonb,
    3
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    'multiple_choice',
    'The treat I would pick right now is…',
    '["Something chocolate", "Something fruity", "Something salty", "A fancy drink"]'::jsonb,
    4
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'short_answer',
    'What is my go-to comfort food?',
    null,
    5
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000002',
    'multiple_choice',
    'The part of our story I retell most is…',
    '["How we met", "Our first date", "Our first trip", "A funny mishap"]'::jsonb,
    1
  ),
  (
    '20000000-0000-4000-8000-000000000007',
    '10000000-0000-4000-8000-000000000002',
    'multiple_choice',
    'I first knew this was special because…',
    '["Conversation felt easy", "You made me laugh", "I felt understood", "I missed you immediately"]'::jsonb,
    2
  ),
  (
    '20000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000002',
    'multiple_choice',
    'Our strongest shared quality is…',
    '["We communicate", "We stay playful", "We support each other", "We keep growing"]'::jsonb,
    3
  ),
  (
    '20000000-0000-4000-8000-000000000009',
    '10000000-0000-4000-8000-000000000002',
    'multiple_choice',
    'The memory I would happily relive is…',
    '["A quiet everyday moment", "A celebration", "A trip together", "A ridiculous laugh"]'::jsonb,
    4
  ),
  (
    '20000000-0000-4000-8000-000000000010',
    '10000000-0000-4000-8000-000000000002',
    'short_answer',
    'What song reminds me most of us?',
    null,
    5
  ),
  (
    '20000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000003',
    'multiple_choice',
    'Our next big shared adventure should be…',
    '["A city break", "A beach escape", "A nature trip", "A staycation"]'::jsonb,
    1
  ),
  (
    '20000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000003',
    'multiple_choice',
    'A future home feels happiest with…',
    '["Lots of hosting", "A cozy quiet space", "Pets everywhere", "Projects in progress"]'::jsonb,
    2
  ),
  (
    '20000000-0000-4000-8000-000000000013',
    '10000000-0000-4000-8000-000000000003',
    'multiple_choice',
    'The tradition I most want us to create is…',
    '["A yearly trip", "A weekly date", "Holiday rituals", "A daily check-in"]'::jsonb,
    3
  ),
  (
    '20000000-0000-4000-8000-000000000014',
    '10000000-0000-4000-8000-000000000003',
    'multiple_choice',
    'One thing I hope never changes is…',
    '["How we laugh", "How we talk", "How we encourage each other", "How we make time"]'::jsonb,
    4
  ),
  (
    '20000000-0000-4000-8000-000000000015',
    '10000000-0000-4000-8000-000000000003',
    'short_answer',
    'What place would I most love to visit with you?',
    null,
    5
  )
on conflict (id) do update set
  quiz_id = excluded.quiz_id,
  type = excluded.type,
  prompt = excluded.prompt,
  choices = excluded.choices,
  position = excluded.position;
