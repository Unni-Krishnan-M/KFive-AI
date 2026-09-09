# The multi-platform index digest was recorded from Docker Hub's official image page.
ARG PYTHON_IMAGE=python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7

FROM ${PYTHON_IMAGE} AS dependencies
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=300 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /build
RUN python -m venv /opt/venv
COPY requirements.in ./requirements.in
RUN --mount=type=cache,id=kfive-notebook-pip,target=/root/.cache/pip \
    /opt/venv/bin/python -m pip install --only-binary=:all: --retries 10 --timeout 300 -r requirements.in \
    && /opt/venv/bin/python -m pip check \
    && rm -rf /opt/venv/lib/python3.12/site-packages/pip* /opt/venv/bin/pip*

FROM dependencies AS test
ENV PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONPATH=/opt/runtime \
    MPLBACKEND=Agg
COPY kfive_notebook_runtime /opt/runtime/kfive_notebook_runtime
COPY kfive_runtime.py /opt/runtime/kfive_runtime.py
COPY tests /opt/runtime/tests
WORKDIR /opt/runtime
RUN python -m unittest discover -s tests -v

FROM test AS verifier
ENV PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONPATH=/opt/runtime \
    PYTHONNOUSERSITE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_INDEX=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN rm -rf /opt/runtime/tests \
    && mkdir -p /verify/input /verify/candidate /verify/output \
    && chown 10002:10002 /verify/output \
    && chmod -R a-w /opt/runtime /opt/venv \
    && chmod 0700 /verify/output
WORKDIR /opt/runtime
USER 10002:10002
ENTRYPOINT ["python", "-m", "kfive_notebook_runtime.verifier"]

FROM test AS runtime
ENV PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONPATH=/opt/runtime \
    PYTHONNOUSERSITE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_INDEX=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLBACKEND=Agg
RUN rm -rf /opt/runtime/tests \
    && mkdir -p /work/input /work/output /work/run \
    && chown 10001:10001 /work/output /work/run \
    && chmod -R a-w /opt/runtime /opt/venv \
    && chmod 0700 /work/output /work/run
WORKDIR /opt/runtime
USER 10001:10001
ENTRYPOINT ["python", "-m", "kfive_notebook_runtime.supervisor"]
