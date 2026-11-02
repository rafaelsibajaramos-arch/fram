FROM alpine:3.22 AS download
RUN apk add --no-cache curl ca-certificates
WORKDIR /data
RUN curl --fail --location --retry 3 https://download.geofabrik.de/south-america/colombia-latest.osm.pbf --output colombia.osm.pbf

FROM ghcr.io/project-osrm/osrm-backend:v6.0.0@sha256:729461bcc9ae9e6aafa92c0f93db9b060a32e85d5e72092c01ae4a4a9f1eb564 AS prepare
COPY --from=download /data/colombia.osm.pbf /data/colombia.osm.pbf
RUN osrm-extract --threads 2 -p /opt/car.lua /data/colombia.osm.pbf \
 && osrm-partition --threads 2 /data/colombia.osrm \
 && osrm-customize --threads 2 /data/colombia.osrm

FROM ghcr.io/project-osrm/osrm-backend:v6.0.0@sha256:729461bcc9ae9e6aafa92c0f93db9b060a32e85d5e72092c01ae4a4a9f1eb564
RUN apk add --no-cache nodejs && addgroup -S routing && adduser -S -G routing routing
COPY --from=prepare /data/colombia.osrm* /data/
COPY ATTRIBUTION.md /data/ATTRIBUTION.md
COPY server.cjs /app/server.cjs
EXPOSE 5000
USER routing
CMD ["node", "/app/server.cjs"]
