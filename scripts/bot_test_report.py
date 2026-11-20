"""Read a privacy-preserving summary of the Cloudflare bot's tester activity."""

import argparse
import json

from scripts.cloudflare_cutover import d1


def report(days: int):
    query = f"""
WITH recent AS (
    SELECT event_name, metadata_json FROM analytics_events
    WHERE created_at >= datetime('now', '-{days} days')
), outcomes AS (
    SELECT json_extract(metadata_json, '$.status') AS status, count(*) AS count
    FROM recent WHERE event_name = 'bot_diagnostic' GROUP BY status ORDER BY count DESC
), actions AS (
    SELECT event_name, count(*) AS count FROM recent
    WHERE event_name IN ('user_started','recommendation_viewed','recommendation_next_clicked',
                         'watchlist_added','movie_liked','movie_disliked','movie_watched')
    GROUP BY event_name
), suggestions AS (
    SELECT json_extract(v.metadata_json, '$.reference.title') AS reference,
           json_extract(v.metadata_json, '$.title') AS suggested,
           count(*) AS seen,
           sum(EXISTS(
                 SELECT 1 FROM recent f WHERE f.event_name='movie_disliked'
                 AND json_extract(f.metadata_json, '$.recommendation_id') =
                     json_extract(v.metadata_json, '$.recommendation_id')
               )) AS disliked
    FROM recent v
    WHERE v.event_name='recommendation_viewed' AND json_extract(v.metadata_json, '$.title') IS NOT NULL
    GROUP BY 1, 2 ORDER BY disliked DESC, seen DESC LIMIT 20
)
SELECT {days} AS days,
 (SELECT count(*) FROM users) AS users_total,
 (SELECT count(DISTINCT user_id) FROM recommendations) AS recommendation_recipients,
 (SELECT COALESCE(json_group_object(status,count),'{{}}') FROM outcomes) AS outcomes,
 (SELECT COALESCE(json_group_object(event_name,count),'{{}}') FROM actions) AS actions,
 (SELECT COALESCE(json_group_array(json_object('reference',reference,'suggested',suggested,
            'generated',seen,'disliked',disliked)),'[]') FROM suggestions) AS suggestions;
"""
    row = d1("--command", " ".join(query.split()))[0]["results"][0]
    data = {
        name: json.loads(value) if isinstance(value, str) else value for name, value in row.items()
    }
    print(json.dumps(data, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, choices=range(1, 31), metavar="1–30")
    try:
        report(parser.parse_args().days)
    except Exception as error:
        raise SystemExit(f"Report failed: {type(error).__name__}") from None
