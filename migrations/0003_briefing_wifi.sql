-- Guest/survey Wi-Fi for the site briefing. Field engineers need it on
-- arrival, and it is shown to everyone who can open the project, so store
-- only credentials the customer has issued for the survey team.
ALTER TABLE sites ADD COLUMN wifi_ssid TEXT;
ALTER TABLE sites ADD COLUMN wifi_username TEXT;
ALTER TABLE sites ADD COLUMN wifi_password TEXT;
