#!/usr/bin/env python3
"""Generate 200 diverse training tickets for LoRA fine-tuning."""

import json
import random
from pathlib import Path

# 网络安全类工单描述
CYBER_DESCRIPTIONS = {
    "phishing": [
        "Received an email from 'payroll@company-secure.com' asking to verify my password. The sender email looks fake.",
        "Got a phishing email claiming to be from IT asking me to confirm my login credentials immediately.",
        "Someone sent me a suspicious email with Apple logo asking me to click and verify my account.",
        "Fake Microsoft login page link in email asking to reset password.",
        "Email about package delivery from unknown sender with suspicious link.",
        "Email from 'support@microsoft-security.net' asking to update billing info.",
        "Received email impersonating my bank asking for account verification.",
    ],
    "malware": [
        "My laptop is showing antivirus warnings and running very slow. I think I have malware infection.",
        "Got unexpected popups about security after downloading a file from an email attachment.",
        "System is behaving strangely with multiple virus warning messages appearing.",
        "Downloaded a file from email that seems to have infected the entire computer.",
        "Ransomware warning appeared on my screen blocking access to files.",
        "Computer locked with ransom message demanding payment.",
        "Multiple warning popups claiming I have virus.",
    ],
    "credential_compromise": [
        "Someone logged into my work email account from Tokyo while I'm physically in London office.",
        "My password stopped working today. I suspect someone hacked my account.",
        "Can't change my password - system keeps saying it was recently changed.",
        "My credentials were exposed in a third-party data breach yesterday.",
        "Received notification of unauthorized login from unknown device.",
        "Someone accessed my account multiple times from unfamiliar IP address.",
    ],
    "unauthorized_access": [
        "Found evidence that my files were accessed by someone else on the shared drive.",
        "Someone logged into my account without my permission last night.",
        "Detected unauthorized access to my work email from unfamiliar IP.",
        "Files were modified without my knowledge.",
        "Noticed someone accessed restricted folders with my credentials.",
    ],
    "data_breach": [
        "I accidentally shared the entire customer database with everyone in the company.",
        "Sensitive financial data was exposed to all external business partners.",
        "Personal employee information including SSN was leaked.",
        "Client confidential data was shared in wrong email distribution list.",
        "Discovered sensitive data exposed on public server.",
    ],
    "device_loss": [
        "Lost my work laptop at the airport. It contains company data and customer contracts.",
        "My phone was stolen from the office with customer contact information.",
        "Can't find my USB drive which has all the project files and source code.",
        "Left company laptop on train with sensitive data.",
        "Misplaced external hard drive containing employee records.",
    ],
    "email_exposure": [
        "Sent confidential proposal to wrong email recipient by mistake.",
        "Used reply-all and sent sensitive salary information to entire department.",
        "Accidentally forwarded email containing multiple passwords.",
        "Email with customer PII sent to wrong address.",
    ],
    "suspicious_activity": [
        "I'm seeing unusual network traffic from my account at odd hours.",
        "Multiple failed login attempts detected on my profile today.",
        "Found a strange folder appearing in my email that I didn't create.",
        "Unusual file access patterns on my account.",
    ],
}

# IT 支持类工单描述
IT_DESCRIPTIONS = {
    "network_issue": [
        "My WiFi connection keeps disconnecting every 5 minutes. Very frustrating.",
        "VPN connection is very unstable and drops frequently throughout the day.",
        "I cannot access any company servers from my remote location.",
        "Internet completely down in my office area since this morning.",
        "Network speed is extremely slow, website takes forever to load.",
        "WiFi not working at all today.",
        "Connection keeps timing out and I get disconnected.",
        "Getting network timeout errors constantly.",
    ],
    "hardware_issue": [
        "Laptop keyboard is not responding properly. Multiple keys are stuck.",
        "Monitor screen went completely black and won't turn on anymore.",
        "External hard drive making strange clicking sounds and not mounting.",
        "Laptop is overheating with loud fan noise constantly.",
        "USB port is not working and I can't connect my devices.",
        "Laptop won't boot up at all, stuck on black screen.",
        "Touchpad completely unresponsive.",
    ],
    "software_issue": [
        "Excel keeps crashing whenever I try to open large spreadsheet files.",
        "Microsoft Teams freezes every time I join a video call.",
        "Outlook is not syncing emails and showing error code 0x80070005.",
        "Word document became corrupted and won't open anymore.",
        "Application crashes immediately after I launch it.",
        "Software installation keeps failing with permission errors.",
        "Browser keeps crashing when loading certain websites.",
    ],
    "access_account_issue": [
        "I cannot login to my work account. Credentials not working.",
        "Forgot my password and the reset function is not working at all.",
        "Getting permission denied error when trying to access shared drive.",
        "MFA authentication not accepting my verification code.",
        "Account got locked after too many failed login attempts.",
        "Can't access restricted folder - permission denied.",
    ],
    "communication": [
        "Teams calls keep disconnecting unexpectedly.",
        "Outlook is unable to send my emails.",
        "Slack notifications not showing up.",
        "Video conference has no audio on my end.",
        "Email won't sync with new messages.",
    ],
    "performance_issue": [
        "Laptop is extremely slow, takes 5 minutes just to open a file.",
        "System is freezing constantly making it impossible to work.",
        "Application lag is unbearable when trying to use spreadsheet.",
        "Disk usage showing 100% all the time.",
        "System responding very slowly to all commands.",
    ],
    "service_request": [
        "I need setup of a new laptop for my new position.",
        "Requesting installation of latest software license.",
        "Need additional storage space urgently.",
        "Require a new monitor for my workspace setup.",
        "Request for additional RAM installation.",
    ],
    "technical_incident": [
        "Server infrastructure went down this morning affecting all users.",
        "Database connection error preventing any work.",
        "API endpoint stopped responding and services are down.",
        "System maintenance causing downtime for everyone.",
    ],
}

TIMES = [
    "2 PM today", "this morning", "yesterday", "10:30 AM", "around 3 PM",
    "this afternoon", "last night", "2 hours ago", "9 AM", "early morning",
    "during lunch", "late evening", "midnight", "this morning at 8:30",
    "yesterday afternoon", "this week", "today around noon", "last Monday",
    "an hour ago", "this morning around 7 AM", "30 minutes ago", "earlier today",
]

LOCATIONS = [
    "HQ Building A", "Remote", "Building B", "Third Floor", "Home Office",
    "London Office", "Server Room", "Conference Room", "Unknown", "On-site",
    "First Floor", "Basement", "Cafeteria", "Working from home", "Branch office",
    "Office", "Classroom", "Lab", "Outdoor", "Coffee shop",
]

ACTIONS = [
    "disconnected the device", "restarted the system", "nothing yet",
    "tried restarting", "contacted IT support", "closed the application",
    "cleared cache and cookies", "reset password", "isolated from network",
    "backed up important data", "disabled the account", "cleared antivirus",
    "force stopped the service", "checked system logs", "uninstalled and reinstalled",
]

SEVERITIES = ["critical", "high", "medium", "low"]
IMPACT_SCOPES = ["just me", "my team", "entire department", "company-wide", "external clients"]
WORK_CONTINUITY_IMPACT = ["severe", "moderate", "minor", "none"]

def generate_cyber_ticket():
    """Generate a cyber security ticket."""
    category = random.choice(list(CYBER_DESCRIPTIONS.keys()))
    
    # Mix: 60% 明确, 40% 模糊
    if random.random() > 0.6:
        description = random.choice([
            "Something suspicious happened.",
            "Not sure what's going on but something feels wrong.",
            "Found something weird in my account.",
            "Possible security issue detected.",
            "Something's not right with my system.",
            "Experiencing unusual behavior.",
            "Not entirely sure but concerned.",
            "Weird stuff happening.",
        ])
    else:
        description = random.choice(CYBER_DESCRIPTIONS[category])
    
    return {
        "issue_type": "cyber",
        "category": category,
        "severity": random.choice(SEVERITIES),
        "description": description,
        "noticed_time": random.choice(TIMES),
        "incident_active": random.choice([True, False]),
        "response_taken": random.choice([True, True, False]),
        "response_details": random.choice(ACTIONS) if random.random() > 0.4 else "",
        "location_detail": random.choice(LOCATIONS) if random.random() > 0.4 else "",
        "data_involved_flag": random.choice([True, False]),
        "external_party_involved": random.choice([True, False, False]),
        "already_reported_to_it": random.choice([True, False]),
        "impact_scope": random.choice(IMPACT_SCOPES),
        "work_continuity": random.choice(WORK_CONTINUITY_IMPACT),
    }

def generate_it_ticket():
    """Generate an IT support ticket."""
    category = random.choice(list(IT_DESCRIPTIONS.keys()))
    
    # Mix: 55% 明确, 45% 模糊
    if random.random() > 0.55:
        description = random.choice([
            "Something is broken.",
            "System not working.",
            "Having issues with device.",
            "Problem with my computer.",
            "Equipment malfunctioning.",
            "Not functioning properly.",
            "Issues with setup.",
        ])
    else:
        description = random.choice(IT_DESCRIPTIONS[category])
    
    return {
        "issue_type": "it_support",
        "category": category,
        "severity": random.choice(SEVERITIES),
        "description": description,
        "noticed_time": random.choice(TIMES),
        "incident_active": random.choice([True, False]),
        "response_taken": random.choice([True, False, False]),
        "response_details": random.choice(ACTIONS) if random.random() > 0.5 else "",
        "location_detail": random.choice(LOCATIONS) if random.random() > 0.3 else "",
        "affected_asset": random.choice([
            "laptop", "desktop", "phone", "monitor", "router", "server",
            "printer", "network", "software", "application"
        ]) if random.random() > 0.4 else "",
        "error_symptom": description.split('.')[0] if random.random() > 0.5 else "",
        "impact_scope": random.choice(IMPACT_SCOPES),
        "work_continuity": random.choice(WORK_CONTINUITY_IMPACT),
    }

def main():
    output_dir = Path(__file__).parent / "data"
    output_dir.mkdir(exist_ok=True)
    
    output_file = output_dir / "training_data.jsonl"
    
    print("Generating 200 training tickets...\n")
    tickets = []
    
    # 100 Cyber + 100 IT Support
    for _ in range(100):
        tickets.append(generate_cyber_ticket())
    
    for _ in range(100):
        tickets.append(generate_it_ticket())
    
    random.shuffle(tickets)
    
    # Save JSONL
    with open(output_file, 'w', encoding='utf-8') as f:
        for ticket in tickets:
            f.write(json.dumps(ticket, ensure_ascii=False) + '\n')
    
    # Statistics
    cyber_count = sum(1 for t in tickets if t['issue_type'] == 'cyber')
    it_count = sum(1 for t in tickets if t['issue_type'] == 'it_support')
    
    print(f"✅ Generated {len(tickets)} tickets")
    print(f"   Cyber Security: {cyber_count}")
    print(f"   IT Support: {it_count}\n")
    
    # Show samples
    print("=== Sample Tickets ===\n")
    for i in range(5):
        t = tickets[i]
        print(f"{i+1}. {t['issue_type'].upper()} - {t['category']} ({t['severity']})")
        print(f"   Description: {t['description'][:70]}...")
        print(f"   Time: {t['noticed_time']}")
        print(f"   Location: {t['location_detail'] or 'N/A'}")
        print(f"   Action taken: {t['response_taken']}\n")
    
    print(f"📁 Saved to: {output_file}\n")
    
    return str(output_file)

if __name__ == "__main__":
    main()
