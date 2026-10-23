# Leaving MTL

Sortir de Montréal ce soir : la circulation en direct sur les ponts, le tunnel et les autoroutes qui quittent l'île — le site derrière [@leavingmtl](https://instagram.com/leavingmtl).

How it works: a GitHub Action (`poll.yml`, started every 15 minutes from 2:30 to 8:15pm by cron-job.org) reads TomTom's Traffic Flow API at one point on each way off the island (`crossings.json`) and saves the day's readings to `days/YYYY-MM-DD.json` on the `data` branch. The page reads those files; the TomTom key stays in the repo's secrets. Every evening `nightly.yml` makes the French-narrated video at `/tonight/`, and `post.yml` posts it as a Reel.

Traffic data © TomTom. Basemap © CARTO / OpenStreetMap, drawn with MapLibre.
