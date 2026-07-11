#!/usr/bin/env bash
# Simulates the extension → API → dashboard path (what the popup does on Save).
set -euo pipefail
API="${API_BASE:-http://localhost:4000}"

echo "1. Health check"
curl -sf "$API/health" >/dev/null
echo "   API ok"

echo "2. Bulk save (truncated LinkedIn URL — same as search results)"
RESULT=$(curl -sf -X POST "$API/api/candidates/bulk" \
  -H 'content-type: application/json' \
  -d '{
    "company": "Amazon",
    "candidates": [
      {
        "fullName": "E2E Test Recruiter",
        "firstName": "E2E",
        "linkedinUrl": "https://www.linkedin.com/in/e2e-test-recruiter-xyz",
        "title": "Technical Recruiter"
      }
    ]
  }')
echo "   $RESULT"

echo "3. Dashboard state"
STATE=$(curl -sf "$API/api/state")
COUNT=$(echo "$STATE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['candidates']))")
echo "   active candidates: $COUNT"
if [ "$COUNT" -lt 1 ]; then
  echo "FAIL: expected at least 1 active candidate"
  exit 1
fi
echo "PASS: extension save flow works end-to-end"
