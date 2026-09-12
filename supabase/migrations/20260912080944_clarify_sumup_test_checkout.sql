update public.vp_settings
set studio_config=jsonb_set(
  studio_config,
  '{content,paymentNote}',
  to_jsonb('Sicherer SumUp-Testcheckout · Es wird kein echtes Geld belastet. Dein Tisch bleibt 30 Minuten reserviert.'::text)
),updated_at=now()
where id=true
  and studio_config #>> '{content,paymentNote}'='Sicher mit SumUp bezahlen. Dein Tisch bleibt während des Checkouts 30 Minuten reserviert.';
