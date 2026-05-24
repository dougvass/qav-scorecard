#!/bin/bash
# QAV Scorecard — push to GitHub and trigger Vercel deploy
# Usage: ./push-to-github.sh https://github.com/YOUR_USERNAME/qav-scorecard.git

set -e

REPO_URL="${1}"

if [ -z "${REPO_URL}" ]; then
    echo "Usage: ./push-to-github.sh https://github.com/YOUR_USERNAME/qav-scorecard.git"
    echo ""
    echo "Steps:"
    echo "  1. Go to https://github.com/new"
    echo "  2. Create a repo named 'qav-scorecard'"
    echo "  3. Copy the HTTPS URL (e.g. https://github.com/vassdoug/qav-scorecard.git)"
    echo "  4. Run: ./push-to-github.sh <that URL>"
    exit 1
fi

echo "Connecting to GitHub repository: ${REPO_URL}"
git remote add origin "${REPO_URL}" 2>/dev/null || git remote set-url origin "${REPO_URL}"
git branch -M main
git push -u origin main

echo ""
echo "✓ Code pushed to GitHub!"
echo ""
echo "Next: Connect Vercel to this repo:"
echo "  1. Go to https://vercel.com/vassdoug-8429s-projects/v0-asx-stock-filter/settings/git"
echo "  2. Click 'Connect Git Repository'"
echo "  3. Select GitHub → choose 'qav-scorecard'"
echo "  4. Set Root Directory: leave blank (or /)"
echo "  5. Click Save — Vercel will deploy automatically"
echo ""
echo "Or create a fresh Vercel project:"
echo "  https://vercel.com/new → Import Git Repository → qav-scorecard"
