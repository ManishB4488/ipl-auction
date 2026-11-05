export const IPL_TEAMS = [
  { name: 'Chennai Super Kings', short: 'CSK', color: '#FDB913', wiki: 'Chennai_Super_Kings' },
  { name: 'Mumbai Indians', short: 'MI', color: '#004BA0', wiki: 'Mumbai_Indians' },
  { name: 'Royal Challengers Bengaluru', short: 'RCB', color: '#D1171B', wiki: 'Royal_Challengers_Bengaluru' },
  { name: 'Kolkata Knight Riders', short: 'KKR', color: '#3A225D', wiki: 'Kolkata_Knight_Riders' },
  { name: 'Delhi Capitals', short: 'DC', color: '#17479E', wiki: 'Delhi_Capitals' },
  { name: 'Sunrisers Hyderabad', short: 'SRH', color: '#F26522', wiki: 'Sunrisers_Hyderabad' },
  { name: 'Rajasthan Royals', short: 'RR', color: '#EA1A85', wiki: 'Rajasthan_Royals' },
  { name: 'Punjab Kings', short: 'PBKS', color: '#D71920', wiki: 'Punjab_Kings' },
  { name: 'Lucknow Super Giants', short: 'LSG', color: '#00A8E0', wiki: 'Lucknow_Super_Giants' },
  { name: 'Gujarat Titans', short: 'GT', color: '#1C2C5B', wiki: 'Gujarat_Titans' },
];
export const teamInfo = (name) => IPL_TEAMS.find((t) => t.name === name) || { short: (name || '?').slice(0, 3).toUpperCase(), color: '#888', wiki: null };
