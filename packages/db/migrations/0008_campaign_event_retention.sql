-- Keep a bounded event timeline per campaign while retaining recent events
-- for replay and incident review. The trigger needs delete rights, so its
-- owner runs it with a fixed search path; application roles cannot invoke it
-- directly or delete campaign events themselves.
CREATE OR REPLACE FUNCTION public.prune_campaign_event_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.campaign_events
  WHERE campaign_id = NEW.campaign_id
    AND sequence <= NEW.sequence - 2000;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_campaign_event_history() FROM PUBLIC;

CREATE TRIGGER campaign_event_retention_trigger
AFTER INSERT ON public.campaign_events
FOR EACH ROW EXECUTE FUNCTION public.prune_campaign_event_history();
