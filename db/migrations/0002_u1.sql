alter table messages add column steps jsonb;
alter table message_attachments add column kind text not null default 'reference';
