from datetime import datetime, timezone
from app.db import SessionLocal, init_db
from app.models import User, Playlist, Track
import json

init_db()
db = SessionLocal()
try:
    if db.query(User).count() == 0:
        u = User(spotify_id="testuser", display_name="Test User", access_token="x", refresh_token="", token_expires_at=datetime.now(timezone.utc))
        db.add(u); db.commit(); db.refresh(u)
        pl = Playlist(spotify_playlist_id="37i9dQZF1DXcBWIGoYBM5M", name="Mexican Hits", description="demo", user_id=u.id)
        db.add(pl); db.commit(); db.refresh(pl)
        tracks = [
            ("nmn1","Los Tigres del Norte","Norteno","norteno","Norteno","2019","uri-n1","url-n1",0),
            ("nmn2","Los Tigres del Norte","Norteno","norteno","Norteno","2018","uri-n2","url-n2",1),
            ("mar1","Vicente Fernandez","Mariachi","mariachi","Ranchera","2001","uri-m1","url-m1",2),
            ("regg1","Bad Bunny","Reggaeton","reggaeton","Latin Pop","2020","uri-r1","url-r1",3),
            ("cumb1","Bomba Estereo","Cumbia","cumbia","Colombian","2015","uri-c1","url-c1",4),
        ]
        for tid,name,genre,hs,region,year,uri,url,idx in tracks:
            t = Track(
                spotify_track_id=tid, name=name,
                artists=json.dumps([{"id":tid,"name":name,"uri":uri}]),
                album_name=genre, album_id=tid, release_date=year, duration_ms=200000,
                uri=uri, external_url=url,
                danceability=0.6, energy=0.7, key=1, mode=1, loudness=-8, tempo=100,
                time_signature=4, acousticness=0.2, instrumentalness=0.0, liveness=0.1,
                speechiness=0.1, valence=0.5,
                genres=json.dumps([genre]), playlist_track_index=idx, playlist_id=pl.id,
            )
            db.add(t)
        db.commit()
        print("seeded 5 tracks")
    else:
        print("already seeded")
finally:
    db.close()
