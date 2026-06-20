"""One-off: send the welcome email to a real address for visual verification.
Uses the LIVE preview logo URL so the image renders even before the production
/api/assets/logo.png route is deployed."""
import os
from datetime import datetime, timezone, timedelta

TO = "kissingerez@gmail.com"
FIRST = "Nixon"
LOGO = "https://weclips-preview.preview.emergentagent.com/api/assets/logo.png"
PRICE = os.environ.get("SUBSCRIPTION_PRICE_LABEL", "$0.99")
APP_URL = os.environ.get("APP_PUBLIC_URL", "https://weclips.app")
SUPPORT = os.environ.get("SENDGRID_SENDER_EMAIL", "support@weclips.app")
SENDER = os.environ.get("LIFECYCLE_SENDER_EMAIL", "welcome@weclips.app")
API_KEY = os.environ["SENDGRID_API_KEY"]

exp = datetime.now(timezone.utc) + timedelta(days=7)
charge_date = f"{exp:%B} {exp.day}, {exp.year}"

html = f"""
<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0F172A;">
  <div style="text-align:center;margin-bottom:24px;">
    <img src="{LOGO}" alt="WeClips" width="72" height="72" style="border-radius:16px;display:inline-block;" />
  </div>
  <h1 style="font-size:24px;margin:0 0 12px;">Welcome, {FIRST} 👋</h1>
  <p style="color:#334155;line-height:1.6;font-size:16px;margin:0 0 20px;">
    Your <b>7-day free trial</b> is live. You can now watch every clip ad-free,
    follow creators, and upload your own. Your first {PRICE} charge will be on <b>{charge_date}</b>.
  </p>
  <p style="margin:0 0 28px;">
    <a href="{APP_URL}" style="background:#89CFF0;color:#0A1929;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;display:inline-block;">
      Open WeClips &rarr;
    </a>
  </p>
  <h2 style="font-size:18px;margin:0 0 12px;">A few things to try first</h2>
  <ul style="color:#334155;line-height:1.7;font-size:15px;padding-left:20px;margin:0 0 28px;">
    <li>Tap any clip on the Discover page &mdash; they all stream ad-free now.</li>
    <li>Hit the <b>Upload</b> tab and share your first clip (up to 25 GB).</li>
    <li>Use the search bar at the top of Discover to find creators by handle.</li>
  </ul>
  <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0;" />
  <p style="color:#64748B;font-size:14px;line-height:1.6;margin:0;">
    Need a hand? Just reply to this email or write to
    <a href="mailto:{SUPPORT}" style="color:#2563EB;">{SUPPORT}</a>.
    You can cancel anytime from <b>Settings &rarr; Membership &rarr; Manage subscription</b>
    &mdash; no charge if you cancel before day 7.
  </p>
</div>
"""

from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail

msg = Mail(
    from_email=SENDER,
    to_emails=TO,
    subject="Welcome to WeClips — your 7-day free trial is live",
    html_content=html,
)
resp = SendGridAPIClient(API_KEY).send(msg)
print("status", resp.status_code, "-> sent to", TO)
