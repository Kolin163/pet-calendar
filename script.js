const API_URL = "https://script.google.com/macros/s/AKfycbzHEtFbPBd9LBd6GOAdceJmp_b_Z4E7uISiPXaB3y_J1V_wEOnZDMgVbFo7XaSF_ZSS-A/exec";

let currentDate = new Date();
let bookings = [];
let showArchive = false;

const presetColors = [
    '#667eea', '#764ba2', '#11998e', '#38ef7d',
    '#ff416c', '#ff4b2b', '#f093fb', '#f5576c',
    '#4facfe', '#00f2fe', '#43e97b', '#fa709a',
    '#fee140', '#fa709a', '#a8edea', '#fed6e3'
];

const monthNames = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];

// ====================== GLOBAL LOADER ======================
let loadingScreen = null;

function showLoading() {
    if (!loadingScreen) return;
    loadingScreen.classList.add('active');
    
    const btn = document.querySelector('.add-btn');
    if (btn) {
        btn.textContent = '⏳ Ждите...';
        btn.disabled = true;
    }
}

function hideLoading() {
    if (!loadingScreen) return;
    loadingScreen.classList.remove('active');
    
    const btn = document.querySelector('.add-btn');
    if (btn) {
        btn.textContent = '+ Добавить бронь';
        btn.disabled = false;
    }
}
document.addEventListener('DOMContentLoaded', function() {
    loadingScreen = document.getElementById('loadingScreen');  // ← теперь здесь
    
    fetchBookings();
    renderColorPresets();
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
});

async function fetchBookings() {
    showLoading();
    
    try {
        const response = await fetch(API_URL);
        
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();
        
        bookings = data.map(b => ({
            ...b,
            startDate: b.startDate ? b.startDate.split('T')[0] : "",
            endDate: b.endDate ? b.endDate.split('T')[0] : "",
            price: parseFloat(b.price) || 0
        }));

        renderCalendar();
        renderLegend();
        
    } catch (error) {
        console.error("Ошибка загрузки данных:", error);
        alert("Не удалось загрузить данные из Google. Проверьте подключение к интернету.");
    } finally {
        hideLoading();        // ← Это должно сработать в любом случае
        console.log("Лоадер скрыт (finally)");   // для отладки
    }
}

async function sendToSheets(action, bookingData) {
    showLoading();                    // ← включаем оба лоадера
    try {
        await fetch(API_URL, {
            method: 'POST',
            mode: 'no-cors',
            cache: 'no-cache',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, data: bookingData })
        });
        
        // Небольшая задержка перед обновлением данных
        setTimeout(() => {
            fetchBookings();
        }, 700);
        
    } catch (error) {
        console.error("Ошибка API:", error);
        alert("Ошибка при сохранении данных");
        hideLoading();
    }
}

// Безопасный парсинг строки ГГГГ-ММ-ДД в объект даты (местное время)
function parseDate(dateStr) {
    if (!dateStr) return new Date();
    // Разбиваем строку по дефису: [2026, 04, 02]
    const parts = dateStr.split('-').map(Number);
    // Создаем дату: год, месяц (0-11), день. Время будет 00:00:00 местного времени.
    return new Date(parts[0], parts[1] - 1, parts[2]);
}

// Форматирование даты в строку ГГГГ-ММ-ДД для хранения и сравнения
function formatDate(year, month, day) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// РАСЧЕТ ПРИБЫЛИ (ПРЯМАЯ ПРОПОРЦИЯ ПО ДНЯМ)
function calculateMonthEarnings() {
    const viewYear = currentDate.getFullYear();
    const viewMonth = currentDate.getMonth();
    let totalMonthEarnings = 0;

    // Границы текущего месяца на календаре
    const monthStart = new Date(viewYear, viewMonth, 1);
    const monthEnd = new Date(viewYear, viewMonth + 1, 0);

    bookings.forEach(b => {
        const start = parseDate(b.startDate);
        const end = parseDate(b.endDate);
        const price = parseFloat(b.price) || 0;

        // 1. Общее количество дней брони (включительно)
        const totalDays = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
        if (totalDays <= 0) return;

        const pricePerDay = price / totalDays;

        // 2. Находим пересечение брони с текущим месяцем
        const overlapStart = start < monthStart ? monthStart : start;
        const overlapEnd = end > monthEnd ? monthEnd : end;

        if (overlapStart <= overlapEnd) {
            // Количество дней, выпадающих на этот месяц
            const overlapDays = Math.round((overlapEnd - overlapStart) / (1000 * 60 * 60 * 24)) + 1;
            totalMonthEarnings += overlapDays * pricePerDay;
        }
    });

    document.getElementById('monthEarnings').textContent = Math.round(totalMonthEarnings).toLocaleString('ru-RU');
}

function renderCalendar() {
    const calendar = document.getElementById('calendar');
    const monthDisplay = document.getElementById('currentMonth');
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    monthDisplay.textContent = `${monthNames[month]} ${year}`;
    calendar.innerHTML = '';
    
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = (firstDay.getDay() + 6) % 7;
    
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = startDay - 1; i >= 0; i--) {
        calendar.appendChild(createDayElement(prevMonthLastDay - i, true, year, month - 1));
    }
    
    const todayStr = new Date().toISOString().split('T')[0];
    for (let day = 1; day <= lastDay.getDate(); day++) {
        const dateStr = formatDate(year, month, day);
        calendar.appendChild(createDayElement(day, false, year, month, dateStr === todayStr));
    }
    
    while (calendar.children.length < 42) {
        const day = calendar.children.length - (lastDay.getDate() + startDay) + 1;
        calendar.appendChild(createDayElement(day, true, year, month + 1));
    }
    calculateMonthEarnings();
}

function createDayElement(day, isOtherMonth, year, month, isToday) {
    const div = document.createElement('div');
    div.className = 'day' + (isOtherMonth ? ' other-month' : '') + (isToday ? ' today' : '');
    
    let dYear = year, dMonth = month;
    if (month < 0) { dMonth = 11; dYear--; }
    else if (month > 11) { dMonth = 0; dYear++; }
    
    const dateStr = formatDate(dYear, dMonth, day);
    div.innerHTML = `<div class="day-number">${day}.${String(dMonth + 1).padStart(2, '0')}</div><div class="bookings-container"></div>`;
    
    const container = div.querySelector('.bookings-container');
    bookings.forEach(b => {
        if (dateStr >= b.startDate && dateStr <= b.endDate) {
            const line = document.createElement('div');
            line.className = 'booking-line';
            line.style.backgroundColor = b.color;
            line.textContent = b.petName;
            line.onclick = (e) => { e.stopPropagation(); openEditModal(b.id); };
            
            if (b.startDate === b.endDate) line.classList.add('single');
            else if (dateStr === b.startDate) line.classList.add('start');
            else if (dateStr === b.endDate) line.classList.add('end');
            else line.classList.add('middle');
            container.appendChild(line);
        }
    });
    return div;
}

function updateDaysCount() {
    const sStr = document.getElementById('startDate').value;
    const eStr = document.getElementById('endDate').value;
    const comment = document.getElementById('daysCountComment');
    if (sStr && eStr) {
        const s = parseDate(sStr);
        const e = parseDate(eStr);
        const diff = Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
        comment.textContent = diff > 0 ? `📊 Всего дней: ${diff}` : '⚠️ Ошибка дат';
        comment.style.color = diff > 0 ? '#667eea' : '#ff416c';
    }
    updatePricePerDay();
}

function updatePricePerDay() {
    const sStr = document.getElementById('startDate').value;
    const eStr = document.getElementById('endDate').value;
    const price = document.getElementById('price').value;
    const comment = document.getElementById('pricePerDayComment');
    if (sStr && eStr && price > 0) {
        const s = parseDate(sStr);
        const e = parseDate(eStr);
        const diff = Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
        if (diff > 0) {
            const perDay = Math.round(parseFloat(price) / diff);
            comment.textContent = `📊 Цена за день: ${perDay} руб.`;
        }
    }
}

function prevMonth() { currentDate.setMonth(currentDate.getMonth() - 1); renderCalendar(); }
function nextMonth() { currentDate.setMonth(currentDate.getMonth() + 1); renderCalendar(); }

function openModal() {
    document.getElementById('addModal').classList.add('active');
    document.getElementById('modalTitle').textContent = 'Новая бронь';
    document.getElementById('bookingForm').reset();
    document.getElementById('editingId').value = '';
    document.getElementById('bookingDetails').style.display = 'none';
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('startDate').value = today;
    document.getElementById('endDate').value = today;
    updateDaysCount();
}

function openEditModal(id) {
    const b = bookings.find(item => item.id.toString() === id.toString());
    if (!b) return;
    document.getElementById('addModal').classList.add('active');
    document.getElementById('modalTitle').textContent = 'Редактировать';
    document.getElementById('petName').value = b.petName;
    document.getElementById('startDate').value = b.startDate;
    document.getElementById('endDate').value = b.endDate;
    document.getElementById('colorPicker').value = b.color;
    document.getElementById('price').value = b.price;
    document.getElementById('editingId').value = b.id;
    document.getElementById('bookingDetails').style.display = 'block';
    updateDaysCount();
}

function closeModal() { document.getElementById('addModal').classList.remove('active'); }

async function saveBooking(event) {
    event.preventDefault();
    const id = document.getElementById('editingId').value || Date.now().toString();
    const data = {
        id: id,
        petName: document.getElementById('petName').value.trim(),
        startDate: document.getElementById('startDate').value,
        endDate: document.getElementById('endDate').value,
        price: document.getElementById('price').value || 0,
        color: document.getElementById('colorPicker').value
    };
    closeModal();
    await sendToSheets('save', data);
}

async function deleteBooking() {
    const id = document.getElementById('editingId').value;
    if (!id || !confirm('Удалить бронь?')) return;
    closeModal();
    await sendToSheets('delete', { id: id });
}

function renderLegend() {
    const container = document.getElementById('legendItems');
    const header = document.querySelector('.legend h3');
    if (!document.getElementById('archiveToggle')) {
        const btn = document.createElement('button');
        btn.id = 'archiveToggle'; btn.className = 'nav-btn'; btn.style.marginLeft = '15px';
        btn.textContent = '📦 Архив';
        btn.onclick = () => { showArchive = !showArchive; btn.textContent = showArchive ? '📋 Активные' : '📦 Архив'; renderLegend(); };
        header.appendChild(btn);
    }
    container.innerHTML = '';
    const todayStr = new Date().toISOString().split('T')[0];
    const filtered = bookings.filter(b => showArchive ? b.endDate < todayStr : b.endDate >= todayStr)
                             .sort((a,b) => a.startDate.localeCompare(b.startDate));
    if (filtered.length === 0) {
        container.innerHTML = '<p style="padding:10px; color:#666;">Ничего не найдено</p>';
        return;
    }
    filtered.forEach(b => {
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.onclick = () => openEditModal(b.id);
        const s = b.startDate.split('-').reverse().join('.');
        const e = b.endDate.split('-').reverse().join('.');
        item.innerHTML = `
            <div class="legend-color" style="background-color: ${b.color}"></div>
            <div>
                <div class="legend-text">${b.petName}</div>
                <div class="legend-dates">${s} — ${e}</div>
                <div class="legend-dates">💰 ${b.price} руб.</div>
            </div>
        `;
        container.appendChild(item);
    });
}

function renderColorPresets() {
    const container = document.getElementById('colorPresets');
    const picker = document.getElementById('colorPicker');
    presetColors.forEach(color => {
        const div = document.createElement('div');
        div.className = 'color-preset';
        div.style.backgroundColor = color;
        div.onclick = () => {
            picker.value = color;
            document.querySelectorAll('.color-preset').forEach(p => p.classList.remove('selected'));
            div.classList.add('selected');
        };
        container.appendChild(div);
    });
}

document.getElementById('addModal').addEventListener('click', function(e) { if (e.target === this) closeModal(); });