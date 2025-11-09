require('dotenv').config();
const fs = require('fs');
const { google } = require('googleapis');
const { Client } = require('@notionhq/client');

const sa = JSON.parse(fs.readFileSync(process.env.SERVICE_ACCOUNT));

const auth = new google.auth.JWT(sa.client_email, null, sa.private_key, [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/contacts'
]);

const sheets = google.sheets({ version: 'v4', auth });
const people = google.people({ version: 'v1', auth });
const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function sync() {
  console.log("SYNC STARTED →", new Date().toLocaleString());

  // Read from Sheet: A=Name, B=Phone, C=Member ID
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Members!A2:C'
  });

  const rows = res.data.values || [];
  console.log(`Found ${rows.length} members in Google Sheet`);

  // Fetch all existing Notion pages
  let existing = [];
  let nextCursor = undefined;
  do {
    const response = await notion.databases.query({
      database_id: process.env.NOTION_DB,
      start_cursor: nextCursor
    });
    existing = existing.concat(response.results);
    nextCursor = response.next_cursor;
  } while (nextCursor);

  // Map: Member ID → Notion Page ID
  const notionMap = {};
  existing.forEach(page => {
    const memberId = page.properties["Member ID"]?.title?.[0]?.text?.content;
    if (memberId) notionMap[memberId] = page.id;
  });

  let updated = 0, created = 0;

  for (const row of rows) {
    const name = row[0]?.trim();
    const phone = row[1]?.trim();
    const id = row[2]?.trim() || "N/A";
    if (!name || !phone || !id) continue;

    const pageId = notionMap[id];

    const properties = {
      "First Name": { rich_text: [{ text: { content: name } }] },
      "Mobile Phone": { phone_number: phone },
      "Member ID": { title: [{ text: { content: id } }] }
    };

    try {
      if (pageId) {
        await notion.pages.update({ page_id: pageId, properties });
        console.log(`Updated → ${name} (ID: ${id})`);
        updated++;
      } else {
        await notion.pages.create({
          parent: { database_id: process.env.NOTION_DB },
          properties
        });
        console.log(`Created → ${name} (ID: ${id})`);
        created++;
      }
    } catch (e) {
      console.log(`Error → ${name}:`, e.message);
    }

    // Google Contacts: skip if already exists
    try {
      await people.people.createContact({
        requestBody: {
          names: [{ givenName: name.split(' ')[0] || 'Member', familyName: name.split(' ').slice(1).join(' ') || '' }],
          phoneNumbers: [{ value: phone }],
          userDefined: [{ key: 'Member ID', value: id }]
        }
      });
      console.log(`Contacts → ${name}`);
    } catch (e) {
      // Ignore duplicate contacts
    }
  }

  console.log(`SYNC DONE! Updated: ${updated}, Created: ${created}, Total: ${rows.length}`);
}

sync();
setInterval(sync, 24 * 60 * 60 * 1000); // Daily