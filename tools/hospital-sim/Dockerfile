FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY hospital_sim.py .
CMD ["python", "-u", "hospital_sim.py"]
