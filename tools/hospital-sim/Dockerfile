# Test tool only (ADR 0006): never part of the product images.
FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY hospital_sim.py invariants.py ./
CMD ["python", "-u", "hospital_sim.py"]
