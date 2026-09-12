export type Service = {
  id:string; name:string; short_name:string; description:string; min_people:number; max_people:number|null;
  min_duration_hours:number; max_duration_hours:number; required_tables:number; available_from:string;
  price_cents:number|null; late_price_cents:number|null; billing:"hourly"|"fixed"|"request"; sort_order:number;
};
export type Addon = { id:string; name:string; price_cents:number; sort_order:number; image_url:string };
export type Slot = { start_time:string; available_tables:number };
export type Booking = {
  id:string; reference:string; service_id:string; starts_at:string; ends_at:string; guest_count:number;
  customer_name:string; customer_email:string; customer_phone:string; company:string|null; notes:string|null;
  status:"request"|"confirmed"|"checked_in"|"completed"|"cancelled"|"no_show"|"waitlist";
  payment_status:"open"|"pending"|"paid"|"failed"|"expired"|"refunded"|"invoice"; price_cents:number|null; pin_code:string; table_ids:number[];
};
export const money=(c:number|null)=>c===null?"auf Anfrage":new Intl.NumberFormat("de-CH",{style:"currency",currency:"CHF"}).format(c/100);
export const isoDate=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
export const dateLabel=(iso:string)=>new Intl.DateTimeFormat("de-CH",{weekday:"short",day:"numeric",month:"short"}).format(new Date(`${iso}T12:00:00`));
export const timeLabel=(iso:string)=>new Intl.DateTimeFormat("de-CH",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Zurich"}).format(new Date(iso));
export const statusLabel:Record<Booking["status"],string>={request:"Provisorisch",confirmed:"Bestätigt",checked_in:"Eingecheckt",completed:"Abgeschlossen",cancelled:"Storniert",no_show:"No-show",waitlist:"Warteliste"};
