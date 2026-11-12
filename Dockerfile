FROM ghcr.io/omnetpp/omnetpp:u24.04-6.3.0

USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

ENV INET_ROOT=/opt/inet4.5
RUN mkdir -p /opt/inet4.5 && \
    curl -sSL https://github.com/inet-framework/inet/releases/download/v4.5.4/inet-4.5.4-src.tgz | tar -xz --strip-components=1 -C /opt/inet4.5 && \
    bash -c "source /root/omnetpp/setenv && cd /opt/inet4.5 && source setenv && make makefiles && make -j\$(nproc) MODE=release"

COPY . /opt/florasat
RUN bash -c "source /root/omnetpp/setenv && source /opt/inet4.5/setenv && cd /opt/florasat/src && \
    opp_makemake --make-so -o flora -O out -f --deep -KINET_PROJ=/opt/inet4.5 -DINET_IMPORT -I. -I'\$(INET_PROJ)/src' -L'\$(INET_PROJ)/src' -l'INET\$(D)' && \
    make -j\$(nproc) MODE=release"

WORKDIR /opt/florasat/simulations/Dijkstra132
